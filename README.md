# NotTheRealAPI CLI

Forward provider-signed webhook events from a compatible listener service to a fixed local HTTP endpoint. Optional outbound WebSocket notifications wake HTTPS claims; HTTPS remains authoritative for registration, delivery, ACKs and close. The CLI preserves the original body bytes and signature headers and reports the local handler's outcome. It does not open an inbound tunnel or create or sign events.

**Hosted availability:** this unpublished **0.2.0 candidate** adds provider-neutral `ntapi.listener.v2` and retains frozen Stripe V1 through explicit `--protocol v1`. The current SaaS supports V1 only; V2 requires the separate [server handoff](docs/SAAS-V2-HANDOFF.md). Production hosted listeners are not currently enabled. Notification hints remain `ntapi.listener.notify.v1`. Local tests and package smoke require no hosted credentials.

## Install

The latest published baseline is **0.1.0** (V1 only). This task does not publish 0.2.0. For that published baseline:

```sh
npm install --global @nottherealapi/cli@0.1.0
nottherealapi --help
nottherealapi --version
```

Supported test matrix: Windows, macOS and Linux on Node.js **22.13.0** and **24**. The runtime minimum is Node.js 22.13.0; development requires npm 10+. The package is ESM and includes compiled JavaScript and TypeScript declarations. Installation needs no TypeScript compiler or source checkout.

## Try the local demo

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
npm install -g ./nottherealapi-cli-0.2.0.tgz
nottherealapi --help
```

The [contribution guide](CONTRIBUTING.md) lists development checks. Maintainers: see the [manual release runbook](https://github.com/NotTheRealAPI/cli/blob/main/docs/npm-release.md) and [historical readiness audit](https://github.com/NotTheRealAPI/cli/blob/main/docs/npm-release-readiness.md).

## Connect to a compatible service

For hosted use once listener access is enabled, the following configuration uses the public API origin `https://nottherealapi.com` and Production token scope, with your handler at port 3000. It requires a module and scoped listener token issued by an enabled service; running this command does not enable hosted access:

```sh
nottherealapi listen \
  --protocol v1 \
  --module stripe-payments \
  --forward-to http://localhost:3000/webhook \
  --environment production --json
```

For a local reference service at `http://127.0.0.1:8787`, explicitly permit loopback HTTP. The example address is not a service started by this command; use `npm run demo` for a self-contained run.

```sh
nottherealapi listen \
  --protocol v1 \
  --module stripe-payments \
  --forward-to http://localhost:3000/webhook \
  --api-url http://127.0.0.1:8787 \
  --allow-loopback-api \
  --environment production \
  --once --json
```

These legacy commands deliberately select V1 for the current SaaS and reference demo. For a V2-capable service use `--protocol v2` (the 0.2.0 executable default) with any authorized module. Version selection is fixed for the run; no network/auth/protocol error triggers downgrade.

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

| Option                               | Default / behavior                                                  |
| ------------------------------------ | ------------------------------------------------------------------- |
| `--protocol v2`                      | V2 default; explicit `v1` selects the frozen legacy contract        |
| `--include-verification-url`         | off; V2 only, disclose canonical signing URL to local handler       |
| `--environment production`           | production; scope selector, does not change API hostname            |
| `--api-url HTTPS_ORIGIN`             | `https://nottherealapi.com`; hosted listeners not currently enabled |
| `--allow-loopback-api`               | off; permits HTTP for a loopback reference API                      |
| `--token-file PATH`, `--token VALUE` | environment fallback; mutually exclusive                            |
| `--once`                             | off; process one claim, including failure or uncertain ACK          |
| `--max-idle-polls N`                 | 1 with `--once`, otherwise 0 (unlimited)                            |
| `--json`                             | off; version 1 JSON lines                                           |

An idle `--once` exits 4 after its first bounded HTTPS probe. Use `--max-idle-polls 10` for ten idle HTTPS responses or 0 to wait indefinitely. Hints do not count as idle responses. Continuous mode reports handler outcomes and continues listening. Ctrl+C and SIGTERM cancel requests, sockets and waits. See `--help` for timeout/backoff options; HTTP operations have at most eight retries, and Retry-After above 60 seconds stops the run.

After registration, a fresh single-use HTTPS ticket authenticates each socket; no bearer token is sent in its upgrade. WebSocket `ready` and `resync` hints wake HTTPS claims. Hints are coalesced, including during forwarding or ACK retries; confirmed ACKs drain more eligible work. There is one local request at a time, with server idle pacing respected.

Healthy notifications replace routine idle polling with hints and a **60-second safety probe**. Session renewal continues. Unsupported notifications or socket/network outages resume bounded HTTPS polling and automatic notification retries. In-flight requests and retry deadlines still apply. Socket loss preserves the session and pending ACK evidence. JSON output reports `notifications_ready` or `notifications_fallback`. See the [notification contract](docs/listener-notifications-v1.md) for scheduling details.

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

V2 forwards an opaque body (0–1 MiB), POST and 0–24 authorized end-to-end header pairs. Values are printable ASCII, at most 1024 bytes each and 8192 aggregate name/value bytes; names are HTTP tokens of at most 64 bytes. Content-Type is optional. Generic framing, routing, credential, override and reserved metadata headers are refused. The server owns provider/custom-header admissibility; there is no CLI provider allowlist. See the [exact contract and denylist](docs/listener-protocol-v2.md).

For URL-bound signatures, the cloud supplies optional `verificationUrl` from the canonical public URL it actually signed. Add `--include-verification-url` to disclose it to your local handler as `x-ntapi-listener-verification-url`; the handler passes it to its provider verifier instead of localhost. It never changes forwarding, appears in normal output, or enters ACK evidence. Do not trust this metadata convention on public routes.

**Adding a callback provider within V2 bounds requires zero changes to CLI source, protocol enumerations or release version.** The permanent `provider-agnostic-contract` CI gate changes unfamiliar signature/timestamp/correlation header sets across JSON, form, binary and empty bodies, including the installed tarball. New methods, compressed bodies, non-ASCII headers, larger limits, gRPC or bidirectional streaming require explicit transport design/review.

The handler must verify the original signature against raw request bytes before body parsing, using the synthetic test signing secret supplied by its event source. The CLI never signs or reserializes the body. Delivery is at least once: handlers must deduplicate provider event IDs.

A local HTTP 500 is reported as `outcome=http_error status=500`. An ACK receipt confirms that the service recorded that outcome, not that delivery succeeded. A disconnect after transmission is `uncertain`, even if the handler has committed a side effect. `ack_pending` and `ack_unconfirmed` report sanitized local evidence; there is no automatic disk spool or cross-process ACK replay. Capture `--json` output in a protected file if needed.

Normal diagnostics omit payloads, signature headers, full URLs and credentials. Local response content is discarded before reporting; only status, byte counts, timing, completeness and fixed error classifications are uploaded. No telemetry or payload debug mode is provided.

For connection errors, check the handler's address, port and firewall. For uncertain delivery, inspect handler effects before retrying. Protocol mismatch, denied scope and session conflict stop the run; use a matching service/token or close the other listener.

See the [V2 protocol](docs/listener-protocol-v2.md), [frozen V1 protocol](docs/listener-protocol-v1.md), [security model](docs/security.md), and [vulnerability reporting policy](SECURITY.md).

Code is licensed under [MIT](LICENSE). Trademark and project name rights are separate from the code licence.
