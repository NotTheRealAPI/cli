# Phase A.1 Part 2 — standalone SaaS handoff

Part 1 implements the public CLI only. No private SaaS code, schema, fixtures, secrets or Workflow implementation were imported. The hosted listener API does **not** yet exist according to the supplied brief; no live Preview delivery is claimed. The existing Preview HTTPS receiver suite is a different delivery path.

Baseline references supplied by the owner (not inspected or changed here): Phase A `f4fb525595d3d6dfa687c7621f93e9ea61e9a24a`, Preview correction `99b7a5add96569dc151fa74cd53f3546804560d8`, evidence docs `b75da838c9b4de2cac777c67814f5747f431769b`.

## Contract to implement or explicitly revise

Freeze candidate **`ntapi.listener.v1`** from [protocol specification](listener-protocol-v1.md), [exact JSON Schema definitions](protocol-v1.schema.json), [versioned wire examples](fixtures/v1.json), and public exported Zod schemas/types in `src/protocol.ts`. The JSON examples contain synthetic IDs and a placeholder signature; executable signed examples come from `test/fixture.mjs`. Unknown properties are forbidden. All routes use POST JSON and success HTTP 200:

| Route                                      | Request → response `$defs`          |
| ------------------------------------------ | ----------------------------------- |
| `/listener/v1/sessions`                    | `registerSchema` → `sessionSchema`  |
| `/listener/v1/sessions/{sessionId}/claims` | `pollSchema` → `pollResponseSchema` |
| `/listener/v1/sessions/{sessionId}/acks`   | `ackSchema` → `receiptSchema`       |
| `/listener/v1/sessions/{sessionId}/close`  | `closeSchema` → `closedSchema`      |

Authenticate each request with a dedicated opaque scoped listener token, `ntapi_lst_…`, and version header `X-NTAPI-Listener-Version: ntapi.listener.v1`. Enforce workspace, environment, installed module, destination SHA-256, allowed actions, expiry, revocation and independent Preview/Production feature gates on **every** request. Existing account keys are not listener credentials. Implement usable scoped-token issuance/revocation separately from this CLI; browser/device OAuth is deferred. Confirm `https://nottherealapi.com` as the canonical API origin or explicitly revise the candidate default before hosted use. Preview always supplies its approved HTTPS origin explicitly.

Use client random UUID session IDs, exclusive scope ownership, max 300-second session TTL, idempotent same-ID renewal, and idempotent close. Reject a second owner with 409. Renewal occurs only between claims and does not extend claim deadlines. A new process cannot resume/replay another process's session. Rotate after 256 acknowledged attempts; a missing close expires by TTL.

Claims hold poll requests for at most 10 seconds, return paced idle envelopes, and require no permanently running per-listener function/Workflow. Durable dispatch eligibility and bounded retention remain server-owned. Atomically assign one outstanding claim per session with capability/fencing, max 120-second lease bounded by session and retention. The CLI needs local timeout + 1 second remaining (defaults: local 10 seconds, lease recommended 60 seconds). Redelivery retains provider event ID/raw bytes/signature but creates new delivery/attempt identity; stale generations cannot record outcomes.

Transport the **already signed original bytes** as canonical Base64 plus count/SHA-256. Never reconstruct JSON or sign inside the adapter. Only content-type, stripe-signature and optional stripe-account pairs are admitted, with no duplicates even across casing. Future provider support needs review. The server never sends a destination URL and must not expose private storage/Workflow IDs in public envelopes.

ACKs contain fencing identity, random stable ackKey and actual local outcome. Commit evidence/idempotency **atomically before returning `receipt:recorded`**. Duplicate identical ACKs return the original receipt while token/session remains valid; changed content conflicts. Cloud receipt is distinct from local 2xx, error, timeout and uncertain transmission. Recheck authorization even for stored receipts. No local response text/headers are uploaded in V1 (`[]`, `""`), only status/counts/duration/completeness/enumerated error. Validate outcome consistency server-side in addition to structural schemas.

Implement typed errors/statuses and Retry-After exactly as the protocol table. No unversioned error text, redirects or silent compatibility fallback. The client has bounded retries and cancellation, retains ACK evidence in process only, emits sanitized evidence before uplink, and will never resume a stale lease after restart. Receiver event-ID deduplication remains mandatory.

## Private implementation responsibilities

Adapt existing provider-owned event generation, raw-body signing and asynchronous dispatch without duplicating simulation logic. Add durable abstractions for listener grants/sessions/leases/fencing, unique ACK idempotency records and immutable attempt outcomes; actual tables/migrations belong only in the private repository. Keep HTTPS delivery behavior intact and make transport selection explicit. Transactions/conditional writes must prevent simultaneous owners, concurrent claims, stale ACK writes and ACK/evidence divergence.

Candidate retention policy: 15 minutes from dispatch eligibility, max 8 attempts, bounded retry delays/quotas, no extension by poll/renew/restart, no lease beyond retention, and terminal expired evidence for offline/poison events. Confirm/adopt these policy values or explicitly review them before implementation. CLI acceptance cannot prove hosted durable retention, Workflow restarts, deployment boundaries or operational economics. Add limits/metrics/quotas for polls, payload bytes, pending sessions and attempts; never record secrets/payloads in operational logs. Clock synchronization and latency/cost measurements need hosted validation.

The in-memory reference service enforces auth, bound scope/actions/gates, session conflicts/renewal, claim fencing and idempotent ACK receipts; injected faults cover recovery. It is not a durable SaaS server, production token issuer, database emulator or fork of the private system-test framework. It does not establish real hosting guarantees.

## Extend the existing Preview harness later

Use the existing private HTTPS system-test runner rather than copying it here. Start the packed CLI on a controlled local agent with a handler bound only to loopback, obtain a dedicated Preview listener grant, and drive real SaaS module events. Require:

1. Real Preview cloud → authenticated outbound CLI poll → localhost handler → durable ACK evidence. Prove no public receiver/tunnel was used and no ACK preceded handler completion.
2. Exact byte count/SHA-256 parity from provider raw body to socket; verify original signature with the official Stripe SDK using synthetic secret, including tamper rejection and signature-preserving redelivery.
3. Correlated public event/delivery/attempt IDs; local 2xx/4xx/5xx/redirect/timeout/disconnect distinctions and receipt-versus-success evidence. Repeat local effects must be deduplicated by provider event ID.
4. Lost claim and ACK responses, network partitions, stale generations, lease/session expiry, token expiry/revocation during poll/ACK, dual-owner conflict, disabled Preview gate and cross-environment/workspace/module/destination denial.
5. Offline listener: dispatch, bounded durable pending retention, reconnect before expiry, new process/session after lease expiry, and terminal expiry when the listener never returns. No silent event loss or infinite retries.
6. Hosted function restart and application deployment **between claim and ACK**, after ACK commit/before response, and during durable provider workflow retry. Assert fencing/idempotency survive storage/process boundaries and evidence remains durable.
7. Real Windows/macOS/Linux packed CLI use and clean interrupt with an in-flight handler, showing uncertainty without success ACK. Validate deployed runtime request duration/pacing, payload limits, clock skew behavior, quotas and poll economics under load.
8. Preview and Production gates independent; keep Production disabled and untouched unless separately approved. Record sanitized evidence in the private acceptance report without leaking token, raw body, signature or local route.

Only after those checks may documentation claim actual Preview integration. No npm publication, tag/release, Production mutation or examples-repository change is authorized by this handoff.
