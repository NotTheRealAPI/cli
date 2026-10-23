import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { parseArgs } from "node:util";
import { id, sha256, type Scope } from "./protocol.js";
import type { ProtocolMode } from "./protocols.js";

export class SafeError extends Error {
  constructor(
    public readonly code: string,
    public readonly exitCode = 1,
  ) {
    super(code);
  }
}
export interface Config {
  api: URL;
  target: URL;
  token: string;
  scope: Scope;
  once: boolean;
  json: boolean;
  requestTimeoutMs: number;
  localTimeoutMs: number;
  pollWaitMs: number;
  maxIdlePolls: number;
  backoffMs: number;
  backoffCapMs: number;
  protocol: ProtocolMode;
  includeVerificationUrl: boolean;
}
export function loopbackUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new SafeError("invalid_forward_to", 2);
  }
  // Check spelling before URL canonicalization (reject integer, octal, mapped and shorthand IPs).
  if (
    !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(
      input,
    ) ||
    u.username ||
    u.password ||
    u.hash
  )
    throw new SafeError("loopback_target_required", 2);
  if (u.hostname === "localhost") u.hostname = "127.0.0.1";
  return u;
}
function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return Math.min(max, Math.max(min, fallback));
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw new SafeError("invalid_numeric_option", 2);
  return Number(value);
}
export async function configuration(
  args: string[],
  env = process.env,
): Promise<Config | "help" | "version" | "auth"> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        module: { type: "string" },
        "forward-to": { type: "string" },
        token: { type: "string" },
        "token-file": { type: "string" },
        "api-url": { type: "string" },
        environment: { type: "string" },
        protocol: { type: "string" },
        "include-verification-url": { type: "boolean" },
        "allow-loopback-api": { type: "boolean" },
        once: { type: "boolean" },
        json: { type: "boolean" },
        "request-timeout-ms": { type: "string" },
        "local-timeout-ms": { type: "string" },
        "poll-wait-ms": { type: "string" },
        "max-idle-polls": { type: "string" },
        "backoff-ms": { type: "string" },
        "backoff-cap-ms": { type: "string" },
      },
    });
  } catch {
    throw new SafeError("invalid_arguments", 2);
  }
  const { values: v, positionals: p } = parsed;
  if (v.help || args.length === 0) return "help";
  if (v.version) return "version";
  if (p.length === 1 && p[0] === "auth") return "auth";
  if (p.length !== 1 || p[0] !== "listen")
    throw new SafeError("unknown_command", 2);
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new SafeError("tls_bypass_forbidden", 2);
  if (!id.safeParse(v.module).success || !v["forward-to"])
    throw new SafeError("module_and_forward_to_required", 2);
  const target = loopbackUrl(v["forward-to"]);
  let api: URL;
  try {
    api = new URL(v["api-url"] ?? "https://nottherealapi.com");
  } catch {
    throw new SafeError("invalid_api_url", 2);
  }
  if (
    api.username ||
    api.password ||
    api.hash ||
    api.search ||
    api.pathname !== "/"
  )
    throw new SafeError("api_origin_required", 2);
  if (api.protocol !== "https:") {
    if (!v["allow-loopback-api"] || api.protocol !== "http:")
      throw new SafeError("https_api_required", 2);
    api = loopbackUrl(api.href);
  }
  const environment = v.environment ?? "production";
  const protocol = v.protocol ?? "v2";
  if (protocol !== "v1" && protocol !== "v2")
    throw new SafeError("invalid_protocol_mode", 2);
  if (protocol === "v1" && v["include-verification-url"])
    throw new SafeError("verification_url_requires_v2", 2);
  if (environment !== "preview" && environment !== "production")
    throw new SafeError("invalid_environment", 2);
  if (v.token && v["token-file"])
    throw new SafeError("choose_one_token_source", 2);
  let token = v.token ?? env.NTAPI_LISTENER_TOKEN;
  if (v["token-file"]) {
    if (process.platform === "win32")
      throw new SafeError("use_environment_token_on_windows", 2);
    try {
      const file = await open(
        v["token-file"],
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          (stat.mode & 0o077) !== 0 ||
          stat.uid !== process.getuid?.() ||
          stat.size > 4096
        )
          throw new Error();
        // Read a bounded buffer even if another writer grows the file after stat().
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096) throw new Error();
        token = buffer.subarray(0, bytesRead).toString("utf8").trim();
      } finally {
        await file.close();
      }
    } catch {
      throw new SafeError("protected_token_file_required", 2);
    }
  }
  // Prefix is a type marker, not proof of scope; the server must verify grants on every operation.
  if (!token || !/^ntapi_lst_[A-Za-z0-9_-]{16,2048}$/.test(token))
    throw new SafeError("scoped_listener_token_required", 3);
  const requestTimeoutMs = integer(
    v["request-timeout-ms"],
    15_000,
    100,
    30_000,
  );
  const backoffCapMs = integer(v["backoff-cap-ms"], 30_000, 100, 60_000);
  return {
    api,
    target,
    token,
    protocol,
    includeVerificationUrl: v["include-verification-url"] ?? false,
    scope: { module: v.module!, environment, destination: sha256(target.href) },
    once: v.once ?? false,
    json: v.json ?? false,
    requestTimeoutMs,
    localTimeoutMs: integer(v["local-timeout-ms"], 10_000, 50, 30_000),
    pollWaitMs: integer(
      v["poll-wait-ms"],
      Math.min(10_000, Math.max(0, requestTimeoutMs - 1000)),
      0,
      Math.min(10_000, requestTimeoutMs - 50),
    ),
    maxIdlePolls: integer(v["max-idle-polls"], v.once ? 1 : 0, 0, 1_000_000),
    backoffMs: integer(v["backoff-ms"], 500, 100, backoffCapMs),
    backoffCapMs,
  };
}
