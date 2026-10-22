#!/usr/bin/env node
import { configuration, SafeError } from "./config.js";
import { listen } from "./listener.js";
import { reporter } from "./output.js";

export const HELP = `NotTheRealAPI CLI 0.1.0 — hosted listener Preview
Usage: nottherealapi listen --module ID --forward-to http://localhost:3000/webhooks [options]
       nottherealapi auth | --help | --version
Authentication: NTAPI_LISTENER_TOKEN, --token-file PATH (POSIX owner-only), or --token VALUE
Prefer the environment: command-line tokens are visible in process listings.
Options:
  --environment preview|production    Token environment (default preview)
  --api-url HTTPS_ORIGIN              API origin (default https://nottherealapi.com)
  --allow-loopback-api                Allow HTTP loopback reference server only
  --once                             Process one claim; stop after one idle poll by default
  --max-idle-polls N                  Stop after N idle HTTPS probes (0 unlimited)
  --request-timeout-ms N              Cloud total deadline (100..30000, default 15000)
  --local-timeout-ms N                Local total deadline (50..30000, default 10000)
  --poll-wait-ms N                    Poll hold (0..10000, below request deadline)
  --backoff-ms N                      Initial retry ceiling (100..cap, default 500)
  --backoff-cap-ms N                  Retry ceiling (100..60000, default 30000)
  --json                             Versioned JSON lines; no payload/URL/token output
Exit: 0 local 2xx + ACK receipt, 1 transport/protocol, 2 usage, 3 auth/scope,
      4 idle limit, 5 local failure/uncertain ACK, 130 cancellation.
No browser login endpoint, telemetry, signature generation, or inbound tunnel.
Optional WebSocket hints wake authoritative HTTPS claims; safety probe every 60s.
HTTP polling resumes when notifications are unavailable. One active session per user.
`;
const stop = new AbortController();
const cancel = () => stop.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const config = await configuration(process.argv.slice(2));
  if (config === "help") process.stdout.write(HELP);
  else if (config === "version") process.stdout.write("0.1.0\n");
  else if (config === "auth")
    process.stdout.write(
      "Use an authorized scoped listener token for hosted Preview or the reference fixture. Set NTAPI_LISTENER_TOKEN for this process. The CLI performs no browser login and stores nothing. One active listener session per user.\n",
    );
  else
    process.exitCode = await listen(config, reporter(config.json), stop.signal);
} catch (error) {
  if (stop.signal.aborted) process.exitCode = 130;
  else {
    const code = error instanceof SafeError ? error.code : "request_failed";
    reporter(process.argv.includes("--json"), (line) =>
      process.stderr.write(line),
    )("error", {
      code,
      ...(code === "session_conflict"
        ? { action: "stop_other_listener_or_wait_for_session_expiry" }
        : {}),
    });
    process.exitCode = error instanceof SafeError ? error.exitCode : 1;
  }
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
