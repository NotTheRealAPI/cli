import { z } from "zod";
import { randomUUID } from "node:crypto";
import { wireRequest, TransportError } from "./transport.js";
import { MAX_WIRE, type Scope } from "./protocol.js";
import { protocol, type ProtocolMode, type DeliveryAck } from "./protocols.js";
import { SafeError } from "./config.js";

export class ApiError extends SafeError {
  constructor(
    public readonly status: number,
    code: string,
    public readonly retryAfterMs = 0,
  ) {
    super(code, status === 401 || status === 403 ? 3 : 1);
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
export function retryAfter(
  value: string | string[] | undefined,
  now = Date.now(),
): number {
  if (typeof value !== "string") return 0;
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  // A longer server delay terminates this run; never silently retry earlier than instructed.
  if (!Number.isFinite(ms) || ms < 0) return 0;
  if (ms > 60_000) throw new SafeError("retry_after_exceeds_run_budget");
  return ms;
}
export class ProtocolClient {
  constructor(
    readonly api: URL,
    private token: string,
    readonly timeoutMs: number,
    readonly mode: ProtocolMode = "v1",
  ) {}
  private get contract() {
    return protocol(this.mode);
  }
  private async post<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
    signal: AbortSignal,
    timeout = this.timeoutMs,
  ): Promise<z.output<S>> {
    const response = await wireRequest(
      new URL(`/listener/${this.mode}/${path}`, this.api),
      "POST",
      {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "x-ntapi-listener-version": this.contract.VERSION,
      },
      Buffer.from(JSON.stringify(body)),
      timeout,
      MAX_WIRE,
      signal,
    );
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        String(response.headers["content-type"]),
      ) ||
      (response.headers["content-encoding"] &&
        response.headers["content-encoding"] !== "identity")
    )
      throw new SafeError("invalid_protocol_content_type");
    let data: unknown;
    try {
      data = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new SafeError("invalid_protocol_response");
    }
    if (response.status !== 200) {
      const error = this.contract.errorSchema.safeParse(data);
      if (!error.success) throw new SafeError("invalid_protocol_error");
      const allowed: Record<number, string[]> = {
        401: ["unauthorized"],
        403: ["forbidden"],
        404: ["not_found"],
        409: ["session_conflict", "stale_claim", "version_mismatch"],
        410: ["session_expired", "claim_expired"],
        429: ["rate_limited"],
      };
      if (
        !(
          allowed[response.status] ??
          (response.status >= 500 && response.status <= 599
            ? ["unavailable"]
            : [])
        ).includes(error.data.code)
      )
        throw new SafeError("invalid_protocol_error_status");
      throw new ApiError(
        response.status,
        error.data.code,
        retryAfter(response.headers["retry-after"]),
      );
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new SafeError("protocol_mismatch");
    return parsed.data;
  }
  register(scope: Scope, sessionId: string, signal: AbortSignal) {
    const { VERSION, sessionSchema } = this.contract;
    return this.post(
      "sessions",
      { version: VERSION, sessionId, scope },
      sessionSchema,
      signal,
    );
  }
  poll(sessionId: string, waitMs: number, signal: AbortSignal) {
    const { VERSION, pollResponseSchema } = this.contract;
    return this.post(
      `sessions/${sessionId}/claims`,
      { version: VERSION, waitMs },
      pollResponseSchema,
      signal,
    );
  }
  ack(ack: DeliveryAck, signal: AbortSignal, timeout = this.timeoutMs) {
    const { receiptSchema, ackSchema } = this.contract;
    if (!ackSchema.safeParse(ack).success)
      throw new SafeError("protocol_mismatch");
    return this.post(
      `sessions/${ack.sessionId}/acks`,
      ack,
      receiptSchema,
      signal,
      timeout,
    );
  }
  close(sessionId: string, signal: AbortSignal) {
    const { VERSION, closedSchema } = this.contract;
    return this.post(
      `sessions/${sessionId}/close`,
      { version: VERSION },
      closedSchema,
      signal,
      1000,
    );
  }
}
export const newSessionId = randomUUID;
export const isRetryable = (e: unknown): boolean =>
  e instanceof TransportError || (e instanceof ApiError && e.retryable);
