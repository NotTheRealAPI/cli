import { z } from "zod";
import * as v1 from "./protocol.js";

export const VERSION = "ntapi.listener.v2" as const;
export const MAX_HEADERS = 24;
export const MAX_HEADER_NAME = 64;
export const MAX_HEADER_VALUE = 1024;
export const MAX_HEADER_BYTES = 8192;
export const MAX_VERIFICATION_URL = 2048;
export const VERIFICATION_URL_HEADER = "x-ntapi-listener-verification-url";
const base = { version: z.literal(VERSION) };

// Deny transport, routing, browser security, credentials and local metadata.
// Provider admissibility belongs to the service, never to a client allowlist.
const forbidden = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "authorization",
  "cookie",
  "set-cookie",
  "forwarded",
  "via",
  "expect",
  "content-encoding",
  "accept-encoding",
  "www-authenticate",
  "authentication-info",
  "max-forwards",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
  "x-real-ip",
  "x-url-scheme",
  "front-end-https",
]);
export function safeHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.length <= MAX_HEADER_NAME &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
    !forbidden.has(lower) &&
    !/^(?:proxy-|x-forwarded-|sec-|x-original-|x-rewrite-|x-ntapi-listener-)/.test(
      lower,
    )
  );
}
export const headersSchema = z
  .array(
    z.tuple([
      z
        .string()
        .min(1)
        .max(MAX_HEADER_NAME)
        .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
        .refine(safeHeaderName),
      z
        .string()
        .max(MAX_HEADER_VALUE)
        .regex(/^[\x20-\x7e]*$/),
    ]),
  )
  .max(MAX_HEADERS)
  .superRefine((headers, ctx) => {
    const seen = new Set<string>();
    let bytes = 0;
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (seen.has(lower))
        ctx.addIssue({ code: "custom", message: "duplicate_header" });
      seen.add(lower);
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    }
    if (bytes > MAX_HEADER_BYTES)
      ctx.addIssue({ code: "custom", message: "header_bytes" });
  });
export function safeVerificationUrl(value: string): boolean {
  if (
    value.length > MAX_VERIFICATION_URL ||
    !/^[\x21-\x7e]+$/.test(value) ||
    value.includes("#") ||
    /%(?![a-fA-F0-9]{2})/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.host.includes("@") &&
      !/^https:\/\/[^/]*@/.test(value) &&
      url.href === value
    );
  } catch {
    return false;
  }
}
export const verificationUrlSchema = z
  .string()
  .max(MAX_VERIFICATION_URL)
  .refine(safeVerificationUrl);
export const scopeSchema = v1.scopeSchema;
export const registerSchema = v1.registerSchema.extend(base);
export const sessionSchema = v1.sessionSchema.extend(base);
export const pollSchema = v1.pollSchema.extend(base);
export const claimSchema = v1.claimSchema.extend({
  ...base,
  method: z.literal("POST"),
  headers: headersSchema,
  verificationUrl: verificationUrlSchema.optional(),
});
export const idleSchema = v1.idleSchema.extend(base);
export const pollResponseSchema = z.discriminatedUnion("kind", [
  claimSchema,
  idleSchema,
]);
export const outcomeSchema = v1.outcomeSchema;
export const ackSchema = v1.ackSchema.extend(base);
export const receiptSchema = v1.receiptSchema.extend(base);
export const closeSchema = v1.closeSchema.extend(base);
export const closedSchema = v1.closedSchema.extend(base);
export const errorSchema = v1.errorSchema.extend(base);
export type Claim = z.infer<typeof claimSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Ack = z.infer<typeof ackSchema>;
export { MAX_BODY, MAX_WIRE, sha256, consistentOutcome } from "./protocol.js";

export function decodePayload(
  claim: Claim,
  includeVerificationUrl = false,
): {
  body: Buffer;
  headers: Record<string, string>;
} {
  // Validate even for direct library consumers; no unchecked payload reaches HTTP.
  claimSchema.parse(claim);
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
    body.length > v1.MAX_BODY ||
    v1.sha256(body) !== claim.bodySha256
  )
    throw new Error("invalid_payload");
  // Null prototype also makes syntactically legal names such as __proto__ safe.
  const headers: Record<string, string> = Object.create(null);
  for (const [name, value] of claim.headers) headers[name] = value;
  if (includeVerificationUrl && claim.verificationUrl !== undefined)
    headers[VERIFICATION_URL_HEADER] = claim.verificationUrl;
  return { body, headers };
}
