# NotTheRealAPI CLI

Forward provider-signed webhook events from a compatible listener service to a fixed local HTTP endpoint. Optional outbound WebSocket notifications wake HTTPS claims; HTTPS remains authoritative for registration, delivery, ACKs and close. The CLI preserves the original body bytes and signature headers and reports the local handler's outcome. It does not open an inbound tunnel or create or sign events.

**Availability:** this package is not published on npm. The CLI implements `ntapi.listener.v1` and optional `ntapi.listener.notify.v1` notifications. Production hosted listeners are not currently enabled; CLI protocol support does not enable hosted access. The runnable demo and automated tests use local reference services.

## Run from source

Requires Node.js **22.13.0+** and npm **10+**. From a checkout of this source:

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

The demo starts a reference service and a webhook handler on numerical loopback addresses, runs the CLI, verifies a synthetic signature at the handler, and checks the acknowledgement. It exits after one event and closes both servers. No credentials, Stripe account, public endpoint or paid infrastructure are required.

To build and inspect the executable:

```sh
npm run build
node dist/cli.js --help
node dist/cli.js --version
```

To install the built package locally:

```sh
npm pack
npm install -g ./nottherealapi-cli-0.1.0.tgz
nottherealapi --help
```

The package is ESM and includes compiled JavaScript and TypeScript declarations. Consumers do not need TypeScript. The [contribution guide](CONTRIBUTING.md) lists development checks.

## Connect to a compatible service

For hosted use once listener access is enabled, the following configuration uses the public API origin `https://nottherealapi.com` and Production token scope, with your handler at port 3000. It requires a module and scoped listener token issued by an enabled service; running this command does not enable hosted access:

```sh
node dist/cli.js listen \
  --module stripe-payments \
  --forward-to http://localhost:3000/webhook \
  --environment production --json
```

For a local reference service at `http://127.0.0.1:8787`, explicitly permit loopback HTTP. The example address is not a service started by this command; use `npm run demo` for a self-contained run.

```sh
node dist/cli.js listen \
  --module stripe-payments \
  --forward-to http://localhost:3000/webhook \
  --api-url http://127.0.0.1:8787 \
  --allow-loopback-api \
  --environment production \
  --once --json
```

The built-in API origin is `https://nottherealapi.com`, and token scope defaults to `production`. `--environment` selects token scope; it never changes the API hostname or enables hosted functionality. Select a different authorized API origin with `--api-url`. Non-loopback APIs require HTTPS.

## Authentication

`nottherealapi auth` explains token configuration. It performs no remote login and stores no credentials. Hosted authentication requires a scoped listener token from an enabled service; the CLI has no browser login flow. The listener contract permits one active session per user. A competing session is terminal: stop the other listener or wait for its session to expire. The CLI never takes over a competing listener.

Use a dedicated scoped listener token in `NTAPI_LISTENER_TOKEN`. Accepted tokens start with `ntapi_lst_`; the prefix only identifies the token format. A compatible service must verify workspace, environment, module, destination, allowed actions, expiry and revocation on every request. Account-wide keys and provider signing secrets are not listener tokens.

For Bash or Zsh, read a token without terminal echo or placing its value in shell history:

```sh
printf 'Scoped listener token: '
read -r -s NTAPI_LISTENER_TOKEN
printf '\n'
export NTAPI_LISTENER_TOKEN
```

PowerShell:

```powershell
$listenerSecret = Read-Host 'Scoped listener token' -AsSecureString
$env:NTAPI_LISTENER_TOKEN = [System.Net.NetworkCredential]::new('', $listenerSecret).Password
```

After use, run `unset NTAPI_LISTENER_TOKEN` in Bash/Zsh or `Remove-Item Env:NTAPI_LISTENER_TOKEN; Remove-Variable listenerSecret` in PowerShell. Environment values remain accessible to processes with sufficient OS privileges and are inherited by child processes.

On POSIX, `--token-file PATH` accepts an owner-owned regular file with no group or other permissions (0600 or stricter). Reads are bounded to 4096 bytes and symlinks are refused. Windows rejects token files because POSIX mode bits do not establish ACL protection; use environment injection instead. `--token VALUE` is supported but exposes the value to process listings and shell history. There is no keychain integration, `logout`, or remote `whoami`.

## Commands and configuration

```text
nottherealapi listen --module ID --forward-to URL [options]
nottherealapi auth
nottherealapi --help
nottherealapi --version
```

| Option                               | Default / bound                                                          |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `--environment production\|preview`  | production; scope selector, does not change API hostname                 |
| `--api-url HTTPS_ORIGIN`             | `https://nottherealapi.com`; hosted listeners not currently enabled      |
| `--allow-loopback-api`               | off; permits HTTP for a loopback reference API                           |
| `--token-file PATH`, `--token VALUE` | environment fallback; mutually exclusive                                 |
| `--once`                             | off; process one claim, including failure or uncertain ACK               |
| `--max-idle-polls N`                 | 1 with `--once`, otherwise 0 (unlimited); max 1,000,000                  |
| `--request-timeout-ms N`             | 15000; 100–30000                                                         |
| `--local-timeout-ms N`               | 10000; 50–30000                                                          |
| `--poll-wait-ms N`                   | up to 10000 below the cloud deadline; 0–min(10000, request timeout − 50) |
| `--backoff-ms N`                     | 500, reduced if the cap is lower; 100–backoff cap                        |
| `--backoff-cap-ms N`                 | 30000; 100–60000                                                         |
| `--json`                             | off; version 1 JSON lines                                                |

An idle `--once` exits 4 after its first bounded HTTPS probe, including when notifications are healthy. Use `--max-idle-polls 10` for ten idle HTTPS responses or 0 to wait for an event indefinitely. Hints do not count as idle responses. With healthy notifications, later idle probes wait for hints or the 60-second safety check, so a count of ten can take longer than HTTP polling. Continuous mode reports handler outcomes and continues listening. Retryable HTTP operations have at most eight retries. Retry-After up to 60 seconds overrides the jitter cap; longer delays stop the run. Ctrl+C and SIGTERM cancel requests, socket connections and waits.

After registration, each socket obtains a fresh short-lived, single-use ticket over HTTPS. No bearer token is sent in the socket upgrade. A validated `ready` triggers an immediate HTTPS probe to recover work queued before subscription. `resync` hints are coalesced, including during forwarding or ACK retries, and successful ACKs immediately drain more eligible work. There is one local request at a time. Server idle pacing is respected.

While notifications are healthy, routine five-second idle polling stops. A safety probe runs at most 60 seconds after the previous probe when the listener is idle, even if hints are lost. Session renewal continues before expiry. Unsupported notifications, socket/network loss or notification service outages resume bounded HTTPS polling using server idle pacing (250–30000 ms), with automatic notification retries using jitter and a 1–30 second backoff; unsupported routes retry after 60 seconds. Ongoing requests and existing HTTP retry deadlines still apply. Socket loss never replaces a durable session or discards pending ACK evidence. JSON output adds `notifications_ready` and `notifications_fallback` with fixed reasons and retry timing.

| Exit | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| 0    | Finite delivery: complete local 2xx and cloud ACK receipt           |
| 1    | Transport/protocol/conflict error or exhausted retries              |
| 2    | Invalid arguments or configuration                                  |
| 3    | Missing/invalid token, denied scope or revocation                   |
| 4    | Idle-poll limit reached                                             |
| 5    | Local failure, uncertain delivery or definitive/expired ACK failure |
| 130  | Cancellation                                                        |

## Delivery behavior and limitations

Only literal `localhost`, `127.0.0.1`, and `[::1]` forwarding targets are accepted. The CLI maps `localhost` to `127.0.0.1` without DNS; select `[::1]` for an IPv6-only handler. Bind your handler to loopback. Fixed paths and queries are retained. Redirects are reported as HTTP failures and never followed. Proxy environment variables are ignored. HTTPS requires a certificate valid for the numerical host; there is no TLS bypass option.

The handler must verify the original signature against raw request bytes before body parsing, using the synthetic test signing secret supplied by its event source. The CLI never signs or reserializes the body. Delivery is at least once: handlers must deduplicate provider event IDs.

A local HTTP 500 is reported as `outcome=http_error status=500`. An ACK receipt confirms that the service recorded that outcome, not that delivery succeeded. A disconnect after transmission is `uncertain`, even if the handler has committed a side effect. `ack_pending` and `ack_unconfirmed` report sanitized local evidence; there is no automatic disk spool or cross-process ACK replay. Capture `--json` output in a protected file if needed.

Normal diagnostics omit payloads, signature headers, full URLs and credentials. Local response content is discarded before reporting; only status, byte counts, timing, completeness and fixed error classifications are uploaded. No telemetry or payload debug mode is provided.

For connection errors, check the handler's address, port and firewall. For uncertain delivery, inspect handler effects before retrying. Protocol mismatch, denied scope and session conflict stop the run; use a matching service/token or close the other listener.

See the [protocol specification](docs/listener-protocol-v1.md), [security model](docs/security.md), and [vulnerability reporting policy](SECURITY.md).
