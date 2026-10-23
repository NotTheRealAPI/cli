import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ProtocolClient,
  ApiError,
  isRetryable,
  newSessionId,
} from "./client.js";
import { type Outcome } from "./protocol.js";
import {
  decodeDelivery,
  type DeliveryAck as Ack,
  type DeliverySession as Session,
} from "./protocols.js";
import { SafeError, type Config } from "./config.js";
import { forward } from "./transport.js";
import type { Reporter } from "./output.js";
import { Notifications, SAFETY_MS, Wakeup } from "./notifications.js";

export interface Timing {
  now(): number;
  random(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export const timing: Timing = {
  now: Date.now,
  random: Math.random,
  sleep: async (ms, signal) => {
    await sleep(ms, undefined, { signal });
  },
};
export function delayFor(
  failures: number,
  config: Pick<Config, "backoffMs" | "backoffCapMs">,
  random: number,
  retry = 0,
): number {
  const base = Math.min(
    config.backoffCapMs,
    config.backoffMs * 2 ** Math.min(failures, 16),
  );
  return Math.max(retry, Math.round(base / 2 + (base / 2) * random));
}
export async function listen(
  config: Config,
  report: Reporter,
  signal: AbortSignal,
  clock: Timing = timing,
): Promise<number> {
  const client = new ProtocolClient(
    config.api,
    config.token,
    config.requestTimeoutMs,
    config.protocol,
  );
  let session: Session | undefined,
    sessionId = newSessionId(),
    failures = 0,
    idle = 0,
    refreshes = 0,
    duplicateClaims = 0;
  // Bounded tombstones stop repeated local execution for a duplicate claim; server must advance attempts.
  const seen = new Map<string, Ack>();
  let pending: Ack | undefined;
  const sink = report;
  report = (state, fields = {}) =>
    sink(
      state,
      Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [
          name,
          typeof value === "string"
            ? value.replaceAll(config.token, "[redacted]")
            : value,
        ]),
      ),
    );
  report("disconnected");
  const wake = new Wakeup();
  const notifications = new Notifications(
    config.api,
    config.token,
    config.requestTimeoutMs,
    wake,
    report,
    clock,
  );
  const renewalMargin = config.requestTimeoutMs + config.localTimeoutMs + 2000;
  let lastProbe = clock.now(),
    pollDue = clock.now(),
    nextAllowed = 0;
  const backoff = async (e: unknown, deadline = Infinity) => {
    if (!isRetryable(e) || failures >= 8) throw e;
    const ms = delayFor(
      failures++,
      config,
      clock.random(),
      e instanceof ApiError ? e.retryAfterMs : 0,
    );
    if (clock.now() + ms >= deadline)
      throw new SafeError("ack_unconfirmed_lease_expired", 5);
    report("backoff", { delayMs: ms });
    await clock.sleep(ms, signal);
  };
  try {
    while (!signal.aborted) {
      if (
        !session ||
        Date.parse(session.expiresAt) - clock.now() <= renewalMargin
      ) {
        report("authenticating");
        try {
          const registered = await client.register(
            config.scope,
            sessionId,
            signal,
          );
          const remaining = Date.parse(registered.expiresAt) - clock.now();
          if (
            registered.sessionId !== sessionId ||
            JSON.stringify(registered.scope) !== JSON.stringify(config.scope) ||
            remaining <
              config.requestTimeoutMs + config.localTimeoutMs + 2000 ||
            remaining > 301_000
          )
            throw new SafeError("session_scope_or_ttl_mismatch", 3);
          session = registered;
          failures = 0;
          report("listening", {
            module: config.scope.module,
            environment: config.scope.environment,
            destination: "loopback",
          });
        } catch (e) {
          await backoff(e);
          continue;
        }
      }
      // Optional establishment must not postpone an overdue safety probe. Reserve
      // enough time for ticket, upgrade and ready deadlines before attempting it.
      const connectionBudget =
        config.requestTimeoutMs + 2 * Math.min(config.requestTimeoutMs, 5000);
      const connectionDeferred =
        !notifications.healthy &&
        clock.now() >= notifications.nextAttempt &&
        clock.now() - lastProbe + connectionBudget >= SAFETY_MS;
      if (connectionDeferred) {
        pollDue = clock.now();
        wake.trigger();
      } else await notifications.connectIfDue(session, signal);
      // Respect server idle pacing even when many hints arrive together. Consume the
      // latch before the request so hints during forwarding/ACK remain pending.
      const now = clock.now();
      const probeAt = Math.max(
        nextAllowed,
        Math.min(
          lastProbe + SAFETY_MS,
          notifications.healthy ? (wake.pending ? now : Infinity) : pollDue,
        ),
      );
      const next = Math.min(
        probeAt,
        Date.parse(session.expiresAt) - renewalMargin,
        connectionDeferred ? Infinity : notifications.nextAttempt,
      );
      if (now < next) {
        await wake.wait(next - now, signal, clock);
        continue;
      }
      if (now < probeAt) continue;
      wake.take();
      lastProbe = clock.now();
      let work;
      try {
        work = await client.poll(sessionId, config.pollWaitMs, signal);
        failures = 0;
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status === 410 &&
          e.code === "session_expired"
        ) {
          if (++refreshes > 8) throw new SafeError("repeated_session_expiry");
          session = undefined;
          sessionId = newSessionId();
          notifications.reset();
          wake.trigger();
          seen.clear();
          await clock.sleep(250, signal);
          continue;
        }
        await backoff(e);
        wake.trigger();
        continue;
      }
      refreshes = 0;
      if (work.kind === "idle") {
        if (config.maxIdlePolls && ++idle >= config.maxIdlePolls) {
          report("idle_limit");
          return 4;
        }
        nextAllowed = clock.now() + work.retryAfterMs;
        pollDue = nextAllowed;
        continue;
      }
      idle = 0;
      const deadline = Date.parse(work.expiresAt);
      if (
        work.sessionId !== sessionId ||
        deadline > Date.parse(session.expiresAt) ||
        deadline - clock.now() > 120_000 ||
        Date.parse(work.dispatchAt) > clock.now() + 1000
      )
        throw new SafeError("invalid_claim_lease");
      if (deadline - clock.now() <= config.localTimeoutMs + 1000)
        throw new SafeError("claim_expired_or_too_short", 5);
      const key = `${work.attemptId}:${work.generation}`;
      pending = seen.get(key);
      const duplicate = Boolean(pending);
      if (duplicate) {
        if (++duplicateClaims > 8)
          throw new SafeError("repeated_duplicate_claim");
      } else duplicateClaims = 0;
      if (
        pending &&
        (pending.claimToken !== work.claimToken ||
          pending.deliveryId !== work.deliveryId)
      )
        throw new SafeError("claim_identity_changed");
      if (!pending) {
        // A reused attempt with a new generation must not silently re-execute in this session.
        if ([...seen.values()].some((a) => a.attemptId === work.attemptId))
          throw new SafeError("attempt_generation_changed", 5);
        report("claimed", {
          eventId: work.eventId,
          eventType: work.eventType,
          attempt: work.attempt,
        });
        let payload;
        let outcome: Outcome;
        try {
          payload = decodeDelivery(work, config.includeVerificationUrl);
        } catch {
          /* Poison evidence is reported without forwarding. */
        }
        if (payload) {
          report("forwarding");
          outcome = await forward(
            config.target,
            payload,
            config.localTimeoutMs,
            signal,
          );
        } else
          outcome = {
            classification: "invalid_payload",
            status: null,
            durationMs: 0,
            requestBytes: 0,
            responseBytes: 0,
            responseComplete: false,
            truncated: false,
            error: "validation",
            responseHeaders: [],
            responseBody: "",
          };
        const evidence: Ack = {
          version: work.version,
          sessionId,
          deliveryId: work.deliveryId,
          attemptId: work.attemptId,
          claimToken: work.claimToken,
          generation: work.generation,
          ackKey: randomUUID(),
          outcome,
        };
        pending = evidence;
        seen.set(key, evidence);
        if (seen.size > 256) throw new SafeError("session_attempt_limit", 5);
        report("ack_pending", {
          eventId: work.eventId,
          attemptId: work.attemptId,
          outcome: outcome.classification,
          status: outcome.status,
          durationMs: outcome.durationMs,
          requestBytes: outcome.requestBytes,
          responseBytes: outcome.responseBytes,
          responseComplete: outcome.responseComplete,
          truncated: outcome.truncated,
          error: outcome.error,
        });
      }
      failures = 0;
      const ack = pending;
      if (!ack) throw new SafeError("missing_delivery_evidence", 5);
      while (!signal.aborted) {
        if (clock.now() >= deadline)
          throw new SafeError("ack_unconfirmed_lease_expired", 5);
        try {
          const receipt = await client.ack(
            ack,
            signal,
            Math.max(
              1,
              Math.min(config.requestTimeoutMs, deadline - clock.now()),
            ),
          );
          if (receipt.ackKey !== ack.ackKey)
            throw new SafeError("ack_receipt_mismatch", 5);
          report("acknowledged", {
            attemptId: ack.attemptId,
            outcome: ack.outcome.classification,
            receipt: "recorded",
          });
          const result = ack.outcome.classification === "success" ? 0 : 5;
          pending = undefined;
          if (config.once) return result;
          break;
        } catch (e) {
          if (
            e instanceof ApiError &&
            !e.retryable &&
            e.status !== 401 &&
            e.status !== 403
          )
            throw new SafeError("ack_definitively_rejected", 5);
          await backoff(e, deadline);
        }
      }
      if (signal.aborted) break;
      nextAllowed = 0;
      pollDue = clock.now();
      wake.trigger();
      if (duplicate) await clock.sleep(250, signal);
      // Rotate bounded sessions after a conservative number of deliveries, retaining tombstones until rotation.
      if (seen.size >= 256) {
        await client.close(sessionId, signal);
        session = undefined;
        sessionId = newSessionId();
        notifications.reset();
        seen.clear();
      }
    }
    return 130;
  } finally {
    notifications.stop();
    if (pending)
      report("ack_unconfirmed", {
        attemptId: pending.attemptId,
        outcome: pending.outcome.classification,
        status: pending.outcome.status,
      });
    if (signal.aborted)
      report("shutdown", {
        outcome: pending?.outcome.classification ?? "no_inflight_claim",
      });
    if (session && !pending) {
      try {
        await client.close(sessionId, new AbortController().signal);
      } catch {
        /* TTL bounds orphan sessions. */
      }
    }
  }
}
