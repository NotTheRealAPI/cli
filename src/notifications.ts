import WebSocket from "ws";
import { z } from "zod";
import { wireRequest } from "./transport.js";
import { SafeError } from "./config.js";
import { retryAfter } from "./client.js";
import type { DeliverySession as Session } from "./protocols.js";
import type { Reporter } from "./output.js";
import type { Timing } from "./listener.js";

export const NOTIFY_VERSION = "ntapi.listener.notify.v1";
export const SAFETY_MS = 60_000;
export const MAX_NOTIFY_FRAME = 1024;
const TICKET_CLOCK_SKEW_MS = 2000;
export const ticketSchema = z.strictObject({
  version: z.literal(NOTIFY_VERSION),
  ticket: z.string().regex(/^ntapi_nt_[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
});
const frameSchema = z.strictObject({
  version: z.literal(NOTIFY_VERSION),
  event: z.enum(["ready", "resync", "closing"]),
});

// A single latch retains hints received during HTTP work. There is never a queue of hints.
export class Wakeup {
  pending = true;
  private resolve: (() => void) | undefined;
  trigger = () => {
    this.pending = true;
    this.resolve?.();
  };
  take() {
    this.pending = false;
  }
  async wait(ms: number, signal: AbortSignal, clock: Timing) {
    const stop = new AbortController();
    const abort = () => stop.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await Promise.race([
        clock.sleep(ms, stop.signal),
        new Promise<void>((resolve) => {
          this.resolve = resolve;
        }),
      ]);
    } finally {
      this.resolve = undefined;
      stop.abort();
      signal.removeEventListener("abort", abort);
    }
  }
}

class NotifyUnavailable extends Error {
  constructor(
    readonly unsupported = false,
    readonly retryMs = 0,
  ) {
    super("notifications_unavailable");
  }
}

// Independent hint transport. It never claims, ACKs, forwards, or replaces a session.
export class Notifications {
  healthy = false;
  nextAttempt = 0;
  private failures = 0;
  private identity = "";
  private socket: WebSocket | undefined;
  private disposeSocket: (() => void) | undefined;
  private stopped = false;
  constructor(
    private api: URL,
    private token: string,
    private timeoutMs: number,
    private wake: Wakeup,
    private report: Reporter,
    private clock: Timing,
  ) {}

  reset() {
    this.disposeSocket?.();
    this.identity = "";
    this.healthy = false;
    this.nextAttempt = 0;
  }
  stop() {
    this.stopped = true;
    this.reset();
  }
  async connectIfDue(session: Session, signal: AbortSignal) {
    if (this.identity && this.identity !== session.sessionId) this.reset();
    if (this.stopped || this.socket || this.clock.now() < this.nextAttempt)
      return;
    this.identity = session.sessionId;
    try {
      const ticket = await this.ticket(session, signal);
      signal.throwIfAborted();
      await this.connect(ticket, signal);
    } catch (error) {
      if (signal.aborted) throw new SafeError("cancelled", 130);
      if (error instanceof SafeError) throw error;
      this.failed(error);
    }
  }
  private failed(error: unknown) {
    this.healthy = false;
    const unsupported = error instanceof NotifyUnavailable && error.unsupported;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
    const delay = unsupported
      ? SAFETY_MS
      : Math.max(
          1000,
          Math.round(base / 2 + (base / 2) * this.clock.random()),
          error instanceof NotifyUnavailable ? error.retryMs : 0,
        );
    this.nextAttempt = this.clock.now() + delay;
    this.report("notifications_fallback", {
      reason: unsupported ? "unsupported" : "unavailable",
      retryMs: delay,
    });
    this.wake.trigger();
  }
  private async ticket(session: Session, signal: AbortSignal) {
    const response = await wireRequest(
      new URL("/listener/notify/v1/tickets", this.api),
      "POST",
      {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "x-ntapi-listener-notify-version": NOTIFY_VERSION,
      },
      Buffer.from(
        JSON.stringify({
          version: NOTIFY_VERSION,
          sessionId: session.sessionId,
        }),
      ),
      this.timeoutMs,
      MAX_NOTIFY_FRAME,
      signal,
    );
    // Capture receipt before parsing; issuance follows request transit/processing.
    const receivedAt = this.clock.now();
    // Never inspect or surface arbitrary remote error text. Older HTTP-only fixtures may deny this route.
    if (response.status === 401 || response.status === 403) {
      let code: unknown;
      try {
        code = JSON.parse(response.body.toString("utf8")).code;
      } catch {
        /* fixed diagnostic below */
      }
      if (
        response.status === 403 &&
        [
          "not_configured",
          "feature_not_configured",
          "notifications_not_configured",
          "notifications_unavailable",
        ].includes(String(code))
      )
        throw new NotifyUnavailable(true);
      // Reference HTTP V1 services do not recognize the independently versioned notification request.
      let version: unknown;
      try {
        version = JSON.parse(response.body.toString("utf8")).version;
      } catch {
        /* deny */
      }
      if (
        response.status === 403 &&
        version === "ntapi.listener.v1" &&
        code === "forbidden"
      )
        throw new NotifyUnavailable(true);
      throw new SafeError(
        response.status === 401 ? "unauthorized" : "forbidden",
        3,
      );
    }
    if ([404, 405, 501].includes(response.status))
      throw new NotifyUnavailable(true);
    if (response.status !== 200) {
      let retryMs: number;
      try {
        retryMs = retryAfter(response.headers["retry-after"], this.clock.now());
      } catch {
        retryMs = SAFETY_MS;
      }
      throw new NotifyUnavailable(false, retryMs);
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        String(response.headers["content-type"]),
      ) ||
      (response.headers["content-encoding"] &&
        response.headers["content-encoding"] !== "identity")
    )
      throw new NotifyUnavailable();
    let data: unknown;
    try {
      data = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new NotifyUnavailable();
    }
    const parsed = ticketSchema.safeParse(data);
    if (!parsed.success) throw new NotifyUnavailable();
    const expires = Date.parse(parsed.data.expiresAt);
    if (
      expires <= receivedAt ||
      expires > receivedAt + 30_000 + TICKET_CLOCK_SKEW_MS ||
      expires > Date.parse(session.expiresAt)
    )
      throw new NotifyUnavailable();
    return parsed.data;
  }
  private connect(
    ticket: z.infer<typeof ticketSchema>,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL("/listener/notify/v1/socket", this.api);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      // No upgrade credentials, subprotocols, proxy agent, compression, or redirects.
      const socket = new WebSocket(url, {
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: MAX_NOTIFY_FRAME,
        maxFragments: 16,
        maxBufferedChunks: 32,
        maxHeaderSize: 16_384,
        handshakeTimeout: Math.min(this.timeoutMs, 5000),
        rejectUnauthorized: true,
        autoPong: false,
      });
      this.socket = socket;
      let ready = false,
        disposed = false;
      let deadline = setTimeout(
        () => finish(new NotifyUnavailable()),
        Math.min(this.timeoutMs, 5000),
      );
      const cleanup = (error: unknown = new NotifyUnavailable()) => {
        if (disposed) return;
        disposed = true;
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        socket.removeAllListeners("message");
        socket.removeAllListeners("open");
        socket.removeAllListeners("close");
        socket.removeAllListeners("unexpected-response");
        socket.removeAllListeners("error");
        // terminate may emit a final asynchronous error for an unfinished upgrade.
        socket.on("error", () => {});
        socket.terminate();
        if (this.socket === socket) {
          this.socket = undefined;
          this.disposeSocket = undefined;
          this.healthy = false;
        }
        if (!ready) reject(error);
      };
      const finish = (error: unknown) => {
        if (disposed) return;
        cleanup(error);
        if (ready && !signal.aborted && !this.stopped) this.failed(error);
      };
      const abort = () => finish(new NotifyUnavailable());
      this.disposeSocket = cleanup;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      socket.on("error", () => finish(new NotifyUnavailable()));
      socket.on("close", () => finish(new NotifyUnavailable()));
      socket.on("unexpected-response", (_req, res) => {
        res.destroy();
        finish(
          new NotifyUnavailable([404, 405, 501].includes(res.statusCode ?? 0)),
        );
      });
      socket.on("open", () => {
        if (disposed) return;
        if (Date.parse(ticket.expiresAt) <= this.clock.now()) {
          finish(new NotifyUnavailable());
          return;
        }
        // This envelope is redeemed exactly once; every later connection exchanges a fresh ticket.
        socket.send(
          JSON.stringify({ version: NOTIFY_VERSION, ticket: ticket.ticket }),
          (error) => {
            if (error) finish(new NotifyUnavailable());
          },
        );
        clearTimeout(deadline);
        deadline = setTimeout(
          () => finish(new NotifyUnavailable()),
          Math.min(this.timeoutMs, 5000),
        );
      });
      socket.on("message", (raw, binary) => {
        if (disposed || this.socket !== socket) return;
        let data: unknown;
        try {
          if (binary || !Buffer.isBuffer(raw) || raw.length > MAX_NOTIFY_FRAME)
            throw new Error();
          data = JSON.parse(raw.toString("utf8"));
        } catch {
          finish(new NotifyUnavailable());
          return;
        }
        const frame = frameSchema.safeParse(data);
        if (
          !frame.success ||
          (!ready && frame.data.event !== "ready") ||
          (ready && frame.data.event === "ready")
        ) {
          finish(new NotifyUnavailable());
          return;
        }
        if (frame.data.event === "closing") {
          finish(new NotifyUnavailable());
          return;
        }
        if (!ready) {
          ready = true;
          this.healthy = true;
          this.failures = 0;
          this.nextAttempt = Infinity;
          clearTimeout(deadline);
          // Reconnect even if a peer disappears without sending a close frame.
          deadline = setTimeout(() => finish(new NotifyUnavailable()), 240_000);
          this.report("notifications_ready");
          resolve();
        }
        this.wake.trigger();
      });
    });
  }
}
