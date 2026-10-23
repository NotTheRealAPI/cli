import http from "node:http";
import * as v1 from "../dist/protocol.js";
import * as v2 from "../dist/protocol-v2.js";
import { randomUUID, createHmac } from "node:crypto";
import { VERSION, sha256, consistentOutcome } from "../dist/protocol.js";

// Public synthetic values accepted only by the in-memory reference service.
export const TOKEN = "ntapi_lst_reference_only_0123456789";
export const SECRET = "synthetic_fixture_secret_never_use_in_production";
export async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return {
    instance,
    url: `http://127.0.0.1:${instance.address().port}`,
    close: () =>
      new Promise((resolve) => {
        instance.close(resolve);
        instance.closeAllConnections();
      }),
  };
}
export async function collect(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1_450_000) throw new Error("fixture wire limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function event(
  body = Buffer.from('{ "id": "evt_reference", "text": "héllo 🌍\\n" }\r\n'),
  overrides = {},
) {
  const timestamp = Math.floor(Date.now() / 1000);
  // The reference service creates synthetic signatures; the client only forwards them.
  const signature = createHmac("sha256", SECRET)
    .update(Buffer.from(`${timestamp}.`))
    .update(body)
    .digest("hex");
  return {
    version: VERSION,
    kind: "claim",
    sessionId: randomUUID(),
    deliveryId: randomUUID(),
    attemptId: randomUUID(),
    attempt: 1,
    eventId: "evt_reference",
    eventType: "payment_intent.succeeded",
    claimToken: randomUUID().replaceAll("-", ""),
    generation: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    dispatchAt: new Date().toISOString(),
    bodyBase64: body.toString("base64"),
    bodySha256: sha256(body),
    bodyBytes: body.length,
    headers: [
      ["Content-Type", "application/json"],
      ["Stripe-Signature", `t=${timestamp},v1=${signature}`],
    ],
    ...overrides,
  };
}
export async function cloud({
  protocol = "v1",
  events = [event()],
  faults = {},
  scope,
  sessionTtlMs = 300_000,
  claimTtlMs = 60_000,
  idleMs = 250,
  onAck = () => {},
  mutate = (x) => x,
  now = Date.now,
  enabled = true,
  allowedActions = ["register", "poll", "ack", "close"],
  tokenExpiresAt = Infinity,
} = {}) {
  const { VERSION, registerSchema, pollSchema, ackSchema, closeSchema } =
    protocol === "v1" ? v1 : v2;
  const prefix = `/listener/${protocol}`;
  let session,
    revoked = false,
    generation = 0,
    grantScope = scope,
    outstanding;
  const queue = [...events],
    claims = new Map(),
    receipts = new Map(),
    acks = [],
    calls = [],
    closed = new Set();
  const respond = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const failure = (res, status, code, headers) =>
    respond(res, status, { version: VERSION, code }, headers);
  const fixture = await server(async (req, res) => {
    try {
      const route =
        req.url === `${prefix}/sessions`
          ? "register"
          : req.url?.endsWith("/claims")
            ? "poll"
            : req.url?.endsWith("/acks")
              ? "ack"
              : req.url?.endsWith("/close")
                ? "close"
                : "unknown";
      calls.push({
        route,
        at: now(),
        url: req.url,
        version: req.headers["x-ntapi-listener-version"],
      });
      if (
        req.headers.authorization !== `Bearer ${TOKEN}` ||
        revoked ||
        now() >= tokenExpiresAt
      )
        return failure(res, 401, "unauthorized");
      if (route === "unknown" && protocol === "v2")
        return failure(res, 404, "not_found");
      if (!enabled || !allowedActions.includes(route))
        return failure(res, 403, "forbidden");
      if (req.headers["x-ntapi-listener-version"] !== VERSION)
        return failure(res, 409, "version_mismatch");
      if (req.method !== "POST") return failure(res, 404, "not_found");
      const body = JSON.parse((await collect(req)).toString());
      const fault = faults[route]?.shift();
      if (typeof fault === "function") {
        if (await fault(req, res, body)) return;
      } else if (fault === "disconnect") {
        req.socket.destroy();
        return;
      } else if (fault && typeof fault === "object")
        return failure(res, fault.status, fault.code, fault.headers);
      if (route === "register") {
        const parsed = registerSchema.safeParse(body);
        if (!parsed.success) return failure(res, 409, "version_mismatch");
        if (
          grantScope &&
          JSON.stringify(body.scope) !== JSON.stringify(grantScope)
        )
          return failure(res, 403, "forbidden");
        if (
          session &&
          session.expiresAt > now() &&
          session.id !== body.sessionId
        )
          return failure(res, 409, "session_conflict");
        grantScope ??= body.scope;
        session = {
          id: body.sessionId,
          scope: body.scope,
          expiresAt: now() + sessionTtlMs,
        };
        return respond(
          res,
          200,
          mutate({
            version: VERSION,
            sessionId: session.id,
            scope: session.scope,
            expiresAt: new Date(session.expiresAt).toISOString(),
          }),
        );
      }
      const requestedId = req.url.split("/")[4];
      if (route === "close" && closed.has(requestedId)) {
        closeSchema.parse(body);
        return respond(res, 200, { version: VERSION, closed: true });
      }
      if (!session || !req.url.startsWith(`${prefix}/sessions/${session.id}/`))
        return failure(res, 404, "not_found");
      if (
        grantScope &&
        JSON.stringify(grantScope) !== JSON.stringify(session.scope)
      )
        return failure(res, 403, "forbidden");
      if (session.expiresAt <= now())
        return failure(res, 410, "session_expired");
      if (route === "close") {
        closeSchema.parse(body);
        closed.add(session.id);
        session = undefined;
        outstanding = undefined;
        return respond(res, 200, { version: VERSION, closed: true });
      }
      if (route === "poll") {
        pollSchema.parse(body);
        if (
          outstanding &&
          outstanding.sessionId === session.id &&
          Date.parse(outstanding.expiresAt) > now()
        )
          return respond(res, 200, mutate(outstanding));
        const next = queue.shift();
        if (!next)
          return respond(res, 200, {
            version: VERSION,
            kind: "idle",
            retryAfterMs: idleMs,
          });
        const claim = {
          ...next,
          sessionId: session.id,
          generation: ++generation,
          expiresAt: new Date(
            Math.min(now() + claimTtlMs, session.expiresAt),
          ).toISOString(),
        };
        claims.set(claim.attemptId, claim);
        outstanding = claim;
        return respond(res, 200, mutate(claim));
      }
      if (route === "ack") {
        const parsed = ackSchema.safeParse(body);
        if (!parsed.success) return failure(res, 409, "version_mismatch");
        if (!consistentOutcome(parsed.data.outcome))
          return failure(res, 409, "version_mismatch");
        const prior = receipts.get(body.ackKey);
        if (prior) {
          if (prior.serialized !== JSON.stringify(body))
            return failure(res, 409, "stale_claim");
          return respond(res, 200, prior.receipt);
        }
        const claim = claims.get(body.attemptId);
        if (
          !claim ||
          claim.sessionId !== session.id ||
          claim.claimToken !== body.claimToken ||
          claim.generation !== body.generation ||
          claim.deliveryId !== body.deliveryId
        )
          return failure(res, 409, "stale_claim");
        if (Date.parse(claim.expiresAt) <= now())
          return failure(res, 410, "claim_expired");
        const receipt = {
          version: VERSION,
          ackKey: body.ackKey,
          receipt: "recorded",
        };
        receipts.set(body.ackKey, {
          serialized: JSON.stringify(body),
          receipt,
        });
        acks.push(body);
        outstanding = undefined;
        await onAck(body);
        if (fault === "lost_receipt") {
          req.socket.destroy();
          return;
        }
        return respond(res, 200, receipt);
      }
      failure(res, 404, "not_found");
    } catch {
      if (!res.headersSent) failure(res, 409, "version_mismatch");
      else res.destroy();
    }
  });
  return {
    ...fixture,
    acks,
    calls,
    queue,
    claims,
    receipts,
    revoke: () => {
      revoked = true;
    },
    expireSession: () => {
      if (session) session.expiresAt = 0;
    },
  };
}
