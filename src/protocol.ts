import { z } from "zod";
import { createHash } from "node:crypto";

export const VERSION = "ntapi.listener.v1" as const;
export const MAX_BODY = 1_048_576;
export const MAX_WIRE = 1_450_000;
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const time = z.string().datetime();
const base = { version: z.literal(VERSION) };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const scopeSchema = z.strictObject({
  module: id,
  environment: z.enum(["preview", "production"]),
  destination: digest,
});
export const registerSchema = z.strictObject({
  ...base,
  sessionId: z.uuid(),
  scope: scopeSchema,
});
export const sessionSchema = z.strictObject({
  ...base,
  sessionId: z.uuid(),
  scope: scopeSchema,
  expiresAt: time,
});
export const pollSchema = z.strictObject({
  ...base,
  waitMs: z.number().int().min(0).max(10_000),
});
export const claimSchema = z.strictObject({
  ...base,
  kind: z.literal("claim"),
  sessionId: z.uuid(),
  deliveryId: id,
  attemptId: id,
  attempt: z.number().int().min(1).max(1_000_000),
  eventId: id,
  eventType: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  claimToken: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: time,
  dispatchAt: time,
  bodyBase64: z.string().max(Math.ceil(MAX_BODY / 3) * 4),
  bodySha256: digest,
  bodyBytes: z.number().int().min(0).max(MAX_BODY),
  headers: z.array(z.tuple([z.string().max(64), z.string().max(8192)])).max(3),
});
export const idleSchema = z.strictObject({
  ...base,
  kind: z.literal("idle"),
  retryAfterMs: z.number().int().min(250).max(30_000),
});
export const pollResponseSchema = z.discriminatedUnion("kind", [
  claimSchema,
  idleSchema,
]);
export const outcomeSchema = z.strictObject({
  classification: z.enum([
    "success",
    "http_error",
    "uncertain",
    "connection_error",
    "invalid_payload",
  ]),
  status: z.number().int().min(100).max(599).nullable(),
  durationMs: z.number().int().min(0).max(120_000),
  requestBytes: z.number().int().min(0).max(MAX_BODY),
  responseBytes: z.number().int().min(0).max(65_536),
  responseComplete: z.boolean(),
  truncated: z.boolean(),
  error: z.enum([
    "none",
    "timeout",
    "aborted",
    "socket",
    "response_limit",
    "validation",
  ]),
  // Omitting all response content is intentional: arbitrary secrets cannot be reliably redacted.
  responseHeaders: z.tuple([]),
  responseBody: z.literal(""),
});
export const ackSchema = z.strictObject({
  ...base,
  sessionId: z.uuid(),
  deliveryId: id,
  attemptId: id,
  claimToken: claimSchema.shape.claimToken,
  generation: claimSchema.shape.generation,
  ackKey: z.uuid(),
  outcome: outcomeSchema,
});
export const receiptSchema = z.strictObject({
  ...base,
  ackKey: z.uuid(),
  receipt: z.literal("recorded"),
});
export const closeSchema = z.strictObject({ ...base });
export const closedSchema = z.strictObject({
  ...base,
  closed: z.literal(true),
});
export const errorSchema = z.strictObject({
  ...base,
  code: z.enum([
    "unauthorized",
    "forbidden",
    "not_found",
    "session_conflict",
    "stale_claim",
    "session_expired",
    "claim_expired",
    "rate_limited",
    "unavailable",
    "version_mismatch",
  ]),
});
export type Scope = z.infer<typeof scopeSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type Ack = z.infer<typeof ackSchema>;
export function consistentOutcome(outcome: Outcome): boolean {
  const {
    classification: c,
    status,
    responseComplete: complete,
    error,
    truncated,
  } = outcome;
  if (c === "success" || c === "http_error")
    return (
      complete &&
      status !== null &&
      error === "none" &&
      !truncated &&
      (status >= 200 && status < 300) === (c === "success")
    );
  if (complete || error === "none") return false;
  if (c === "invalid_payload")
    return (
      status === null &&
      error === "validation" &&
      !truncated &&
      outcome.requestBytes === 0 &&
      outcome.responseBytes === 0 &&
      outcome.durationMs === 0
    );
  if (error === "validation") return false;
  if (c === "connection_error")
    return status === null && outcome.requestBytes === 0 && !truncated;
  return c === "uncertain";
}
export const sha256 = (body: Uint8Array | string): string =>
  createHash("sha256").update(body).digest("hex");

export function decodePayload(claim: Claim): {
  body: Buffer;
  headers: Record<string, string>;
} {
  const encoded = claim.bodyBase64;
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    throw new Error("invalid_payload");
  const body = Buffer.from(encoded, "base64");
  if (
    body.toString("base64") !== encoded ||
    body.length !== claim.bodyBytes ||
    body.length > MAX_BODY ||
    sha256(body) !== claim.bodySha256
  )
    throw new Error("invalid_payload");
  const headers: Record<string, string> = {};
  for (const [name, value] of claim.headers) {
    const lower = name.toLowerCase();
    if (
      !["content-type", "stripe-signature", "stripe-account"].includes(lower) ||
      lower in headers ||
      !/^[\x20-\x7e]*$/.test(value)
    )
      throw new Error("invalid_payload");
    headers[lower] = value;
  }
  if (!headers["stripe-signature"] || !headers["content-type"])
    throw new Error("invalid_payload");
  return { body, headers };
}
