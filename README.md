# NotTheRealAPI CLI

Receive provider-owned simulation events over outbound polling and forward their original bytes and signature to a fixed local webhook handler. No inbound tunnel is needed. The hosted service owns signing, event creation, retries and durable evidence; this package is a transport adapter.

**Development candidate: hosted listener support and npm publication are pending.** The V1 endpoints are a proposal frozen by this repository's contract tests. This release has local fake-cloud integration tests, not live Preview integration. Do not send an existing account API key to these proposed routes.

## Try it locally

Use Node.js **22.13.0 or newer** and npm 10+. Node 22 and 24 are the CI targets on Windows, macOS and Linux. The minimum covers the development toolchain as well as the executable. The package is ESM and ships compiled JavaScript; consumers do not need TypeScript.

```sh
git clone https://github.com/NotTheRealAPI/cli.git
cd cli
npm ci --ignore-scripts
npm test
npm run demo
```

The demo starts an authenticated reference cloud and a real receiver on numerical loopback, creates a synthetic signed fixture **in the reference service**, runs the actual CLI subprocess, verifies the signature at the receiver, and checks the uploaded ACK. No credentials, Stripe account, deployed infrastructure or public ingress are required. It exits after one delivery and closes both servers.

After owner-approved publication, the intended hosted command is:

```sh
npx @nottherealapi/cli listen \
  --module stripe-payments \
  --forward-to http://localhost:3000/api/webhooks/stripe \
  --environment preview
```

This command is **not yet a working hosted quick start**. The candidate HTTPS default is `https://nottherealapi.com`; Part 2 must confirm that origin and implement the routes before hosted use. Preview deployments use an explicit `--api-url https://YOUR-APP-PREVIEW.vercel.app --environment preview`. Production has its own token scope and independent server feature gate; an environment option cannot enable a feature remotely.

Without publication, build with `npm run build`, run `node dist/cli.js --help`, or `npm pack` and install the archive with `npm install -g ./nottherealapi-cli-0.1.0.tgz`. `npm run pack:smoke` installs the archive in an isolated temporary consumer and executes its bin. No command publishes a package.

## Authenticate

`nottherealapi auth` describes the ephemeral scoped-token workflow; it performs no remote login and stores nothing. Hosted token issuance and browser/device login are deferred. Only `ntapi_lst_…` listener tokens are accepted. The prefix is a type marker, not authentication: the server must validate expiry, revocation, workspace, environment, installed module, destination digest and allowed actions on every request.

Prefer `NTAPI_LISTENER_TOKEN`. Use your future service-issued **listener** token, never a Stripe signing secret or an account-wide API key. In Bash or Zsh, enter it without terminal echo or shell history:

```sh
printf 'Scoped listener token: '
read -r -s NTAPI_LISTENER_TOKEN
printf '\n'
export NTAPI_LISTENER_TOKEN
node dist/cli.js listen --module stripe-payments --forward-to http://localhost:3000/webhook --environment preview
unset NTAPI_LISTENER_TOKEN
```

PowerShell:

```powershell
$listenerSecret = Read-Host 'Scoped listener token' -AsSecureString
$env:NTAPI_LISTENER_TOKEN = [System.Net.NetworkCredential]::new('', $listenerSecret).Password
node dist/cli.js listen --module stripe-payments --forward-to http://localhost:3000/webhook --environment preview
Remove-Item Env:NTAPI_LISTENER_TOKEN
Remove-Variable listenerSecret
```

Environment values remain readable to processes/users with sufficient OS access and are inherited by child processes. Clear them when done; avoid shared shells. There is no credential persistence, OS keychain integration, `logout`, or remote `whoami`. `--token VALUE` exposes tokens to process listings and shell history; prefer environment or CI secret injection.

On POSIX, `--token-file PATH` reads a regular owner-owned file with no group/other permissions (0600 or stricter), refuses symlinks, and bounds reads to 4096 bytes. Have an existing secrets manager provision it. Windows uses ephemeral environment tokens because POSIX permission bits cannot prove Windows ACL protection; token files are explicitly rejected there.

CI use after Part 2 supplies a scoped token and candidate server:

```yaml
- run: node dist/cli.js listen --module stripe-payments --forward-to http://127.0.0.1:3000/webhook --api-url https://YOUR-APP-PREVIEW.vercel.app --environment preview --once --json
  env:
    NTAPI_LISTENER_TOKEN: ${{ secrets.NTAPI_PREVIEW_LISTENER_TOKEN }}
```

This repository's reference tests and CI checks need **no secret**.

## Commands and outcomes

```text
nottherealapi listen --module ID --forward-to URL [options]
nottherealapi auth
nottherealapi --help
nottherealapi --version
```

| Option                               | Default / bound                                                     |
| ------------------------------------ | ------------------------------------------------------------------- |
| `--environment preview\|production`  | preview                                                             |
| `--api-url HTTPS_ORIGIN`             | candidate `https://nottherealapi.com`                               |
| `--allow-loopback-api`               | off; allows HTTP only for a loopback reference API                  |
| `--token-file PATH`, `--token VALUE` | environment fallback; mutually exclusive                            |
| `--once`                             | off; one claim including failure or uncertain ACK                   |
| `--max-idle-polls N`                 | 1 with `--once`, otherwise 0 (unlimited); max 1,000,000             |
| `--request-timeout-ms N`             | 15000; 100–30000                                                    |
| `--local-timeout-ms N`               | 10000; 50–30000                                                     |
| `--poll-wait-ms N`                   | up to 10000 below cloud timeout; 0–min(10000, request timeout − 50) |
| `--backoff-ms N`                     | 500; 100–backoff cap                                                |
| `--backoff-cap-ms N`                 | 30000; 100–60000                                                    |
| `--json`                             | off; version 1 JSON lines                                           |

An idle `--once` exits 4 after its first bounded poll. Use `--max-idle-polls 10` for ten idle responses or 0 to wait indefinitely. Continuous mode reports outcomes and continues after handler errors; `--once` returns the result's exit code. Retryable operations have at most eight retries. Retry-After up to 60 seconds overrides the jitter cap; longer server delays stop the run. Cancellation interrupts sleeps and requests.

| Exit | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| 0    | Finite claim: complete local 2xx **and** cloud ACK receipt          |
| 1    | Transport/protocol/conflict or exhausted retries                    |
| 2    | Invalid arguments/configuration                                     |
| 3    | Token missing/invalid, denied scope or revocation                   |
| 4    | Idle-poll limit reached                                             |
| 5    | Local failure, uncertain delivery or definitive/expired ACK failure |
| 130  | Ctrl+C / SIGTERM cancellation                                       |

Sanitized output:

```text
listening module=stripe-payments environment=preview destination=loopback
claimed eventId=evt_example eventType=payment_intent.succeeded attempt=1
forwarding
ack_pending eventId=evt_example attemptId=attempt_example outcome=success status=204 durationMs=12 requestBytes=2 responseBytes=0 responseComplete=true truncated=false error=none
acknowledged attemptId=attempt_example outcome=success receipt=recorded
```

A local 500 is `outcome=http_error status=500`. Its subsequent ACK receipt confirms only that the cloud recorded that failure. A disconnect after transmission yields `outcome=uncertain`; the handler might already have committed a side effect. `ack_unconfirmed` preserves the sanitized result when cloud reporting fails. No full URLs, raw bodies, signatures, tokens or arbitrary exception text appear. Capture `--json` in a protected local file for evidence across shutdown; there is no automatic disk spool or cross-process ACK replay.

## Local handler and common problems

Bind your handler to `127.0.0.1` or `::1`. The CLI maps `localhost` to `127.0.0.1` without DNS; select `[::1]` for an IPv6-only handler. Only literal `localhost`, `127.0.0.1`, and `[::1]` are accepted. Fixed paths/queries are retained. Redirects are HTTP failures and never followed. Proxy environment variables are ignored. HTTPS needs a certificate valid for the numerical host; there is no `--insecure`.

The handler must verify the original signature using raw bytes before body parsing, with the **synthetic test secret supplied separately by SaaS**, and deduplicate provider event ID. The CLI never signs or reserializes. Redelivery can carry the same event ID/signature with new delivery/attempt IDs. Never use real Stripe signing secrets here.

`connection_error`: check binding/port/firewall. `uncertain`/`timeout`: inspect handler effects before retrying. `protocol_mismatch`: stop and review versions. `session_conflict`: close the other listener or wait for its bounded TTL; the CLI does not steal it. `unauthorized`/`forbidden`: obtain a scoped listener token matching the environment/module/destination. `https_api_required`: use HTTPS or explicitly opt into HTTP loopback for a reference service.

See [protocol V1](docs/listener-protocol-v1.md), [security](docs/security.md), [development](docs/development.md), and [SaaS handoff](docs/SAAS-HANDOFF.md).
