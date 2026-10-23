import { spawn } from "node:child_process";
import { cloud, event, TOKEN } from "./fixture.mjs";
import { configuration, listen, reporter } from "../dist/index.js";

export function delivery(body = Buffer.from("opaque bytes"), overrides = {}) {
  return event(body, {
    version: "ntapi.listener.v2",
    method: "POST",
    eventType: "future.arrived",
    headers: [
      ["X-Future-Signature", "synthetic=One, two=="],
      ["X-Future-Timestamp", "1234567890"],
      ["X-Future-Correlation", "case-Sensitive_123"],
    ],
    ...overrides,
  });
}
export async function runBin(
  bin,
  remote,
  target,
  { cwd, extra = [], protocol = "v2" } = {},
) {
  const child = spawn(
    process.execPath,
    [
      bin,
      "listen",
      "--protocol",
      protocol,
      "--module",
      "arbitrary-module",
      "--forward-to",
      target,
      "--api-url",
      remote.url,
      "--allow-loopback-api",
      "--once",
      "--json",
      "--request-timeout-ms",
      "1000",
      "--poll-wait-ms",
      "0",
      ...extra,
    ],
    {
      cwd,
      env: {
        ...process.env,
        NTAPI_LISTENER_TOKEN: TOKEN,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
        NODE_USE_ENV_PROXY: "1",
      },
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
export async function setupV2(t, target, options = {}) {
  const remote = await cloud({
    protocol: "v2",
    events: [delivery()],
    ...options,
  });
  t.after(remote.close);
  const config = await configuration(
    [
      "listen",
      "--module",
      "arbitrary-module",
      "--forward-to",
      target,
      "--api-url",
      remote.url,
      "--allow-loopback-api",
      "--once",
      "--local-timeout-ms",
      "300",
      "--request-timeout-ms",
      "1000",
      "--poll-wait-ms",
      "0",
      "--backoff-ms",
      "100",
      "--backoff-cap-ms",
      "100",
    ],
    { NTAPI_LISTENER_TOKEN: TOKEN },
  );
  const lines = [];
  return {
    remote,
    config,
    lines,
    run: () =>
      listen(
        config,
        reporter(true, (line) => lines.push(JSON.parse(line))),
        new AbortController().signal,
      ),
  };
}
