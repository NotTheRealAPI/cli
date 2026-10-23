# Listener delivery V2

Wire version **`ntapi.listener.v2`**, CLI release candidate **0.2.0**. This public client contract describes generic bounded HTTP POST delivery and the local reference implementation. Hosted V2 requires a compatible server deployment; hosted V2 availability has not been established. The current hosted service supports Stripe-only V1, and Production hosted listeners are not currently enabled.

The package includes [JSON Schema 2020-12 definitions](protocol-v2.schema.json), [synthetic wire examples](fixtures/v2.json) and executable validators at `@nottherealapi/cli/protocol-v2`. The schema's `$id` is an identifier, not a hosted API or downloadable-resource promise. Example IDs, tokens, signing inputs and signatures are fabricated; executable tests generate their own synthetic signing material. Structural schemas must be combined with the runtime checks described below.

## Explicit version selection and compatibility

The executable defaults to `--protocol v2`. Select `--protocol v1` explicitly for existing V1 services. Selection is fixed for the entire run, including registration, renewal, claims, ACK and close. There is no capability discovery endpoint and **no automatic downgrade**. A timeout, 401/403, 404, redirect, version mismatch, malformed response or V1-looking response never changes the selected version. Unknown CLI modes are usage errors. Explicit legacy selection is the compatibility mechanism; do not advertise non-Stripe providers on V1.

| Client                          | Server           | Result                                        |
| ------------------------------- | ---------------- | --------------------------------------------- |
| Published 0.1.0                 | V1               | Existing Stripe contract                      |
| 0.2.0 `--protocol v1`           | V1 or dual-stack | Same frozen Stripe contract                   |
| 0.2.0 default / `--protocol v2` | V2 or dual-stack | Provider-neutral V2                           |
| 0.2.0 V2                        | V1 only          | Stops; operator must explicitly select legacy |
| Any V1 client                   | V2 only          | Fails; keep V1 routes for installed clients   |

Package root and `/protocol` retain the published V1 exports, including `VERSION`, `Claim` and `decodePayload`. New V2 exports are isolated at `@nottherealapi/cli/protocol-v2` and the root `v2` namespace. `ProtocolClient(api, token, timeout, "v2")` explicitly selects V2; its three-argument library constructor retains V1 for source compatibility. `configuration()` defaults to V2. `listen()` shares one delivery/ACK engine and narrows claims by their validated wire version. No provider registry, provider enum or provider-dependent dispatch is involved.

## Routes, authentication and durable identity

At the configured API origin use these POST routes with `Authorization: Bearer <scoped listener token>`, `Content-Type: application/json`, `Accept: application/json` and `X-NTAPI-Listener-Version: ntapi.listener.v2`. All successful responses are HTTP 200 JSON, including idle and close. Non-loopback APIs require HTTPS; HTTP is allowed only for an explicitly permitted loopback reference service. Redirects, compressed responses and malformed/non-JSON/oversized envelopes are refused.

| Route                                     | Request                                                                         | HTTP 200 response                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `/listener/v2/sessions`                   | `{version,sessionId,scope}`                                                     | `{version,sessionId,scope,expiresAt}`                |
| `/listener/v2/sessions/:sessionId/claims` | `{version,waitMs}`                                                              | Claim below, or `{version,kind:"idle",retryAfterMs}` |
| `/listener/v2/sessions/:sessionId/acks`   | `{version,sessionId,deliveryId,attemptId,claimToken,generation,ackKey,outcome}` | `{version,ackKey,receipt:"recorded"}`                |
| `/listener/v2/sessions/:sessionId/close`  | `{version}`                                                                     | `{version,closed:true}`                              |

All objects are strict; unknown properties are rejected at every level. Every envelope, including errors, uses `version:"ntapi.listener.v2"`. Path/header/body version mismatches are terminal; a different-version response is a protocol error even when its HTTP status is 401/403. Error bodies are exactly `{version,code}`; permitted status/code pairs and recovery rules appear below.

Scope is exactly `{module,environment,destination}`. Module is an opaque grant/routing identifier of 1–128 `[A-Za-z0-9_-]` characters, independent of provider metadata. Environment is `preview` or `production` and chooses grant scope, never the API host or provider policy. Destination is lowercase hex SHA-256 of the UTF-8 WHATWG URL `href` of the fixed `--forward-to` target, after replacing `localhost` with `127.0.0.1`. URL parsing removes default ports; the fixed path/query remain. Thus `http://localhost:3000/webhook` hashes as `http://127.0.0.1:3000/webhook`. No full local URL is uploaded. A digest is not encryption; guessable destinations can be recovered by enumeration.

Listener tokens have the type marker `ntapi_lst_` followed by 16–2048 ASCII URL-safe characters (`[A-Za-z0-9_-]`). The server verifies user/workspace, route, module, environment, destination, action (`register`, `claim`, `ack`, `close`), expiry, revocation and feature gate on **every** operation, including duplicate ACKs and close. No body digest or CLI token prefix proves provider authenticity or authorization. Account-wide keys and provider signing secrets are not listener tokens. Token issuance, browser login and device authorization are outside this contract.

Registration generates a fresh random UUID `sessionId` per process/session. Its response must echo that exact ID and scope plus UTC ISO `expiresAt`. Session TTL is at most 300 seconds; the client allows one second of upper-bound clock skew and requires at least cloud deadline + local deadline + 2000 ms remaining. Repeating registration with the same ID/scope renews expiry without changing an outstanding claim's deadline or generation. Renewal occurs between claims and while waiting for notifications; no heartbeat route is required. A new process cannot resume another process's session or ACK.

One active listener per user must be enforced atomically across **both versions**. One outstanding claim, unique attempt IDs, monotonic generation fencing, identical lost-claim replay, idempotent ACK and changed-ACK rejection remain mandatory. Keep the same ownership/capability/TTL checks through session renewal. ACK means recorded evidence, including local failure, never implicit local success. There is no client disk spool. Delivery remains at least once; handlers deduplicate event IDs.

A competing session, even for another module or destination, returns 409 `session_conflict`; the CLI stops without takeover. Close revokes ownership and fences unacknowledged claims for bounded redelivery. Repeated close under the same valid token is idempotent; another owner's close is 403/404. Revocation always overrides idempotency. The CLI best-effort closes an idle/finished session on exit with a one-second deadline, but leaves an unconfirmed claim to lease expiry. It closes and rotates after 256 acknowledged attempts to bound its duplicate cache.

## Claims, leases and byte fidelity

Poll `{version,waitMs}` holds outbound HTTPS for 0–10000 ms. The cloud total deadline defaults to 15000 ms and caps at 30000 ms, including response-body consumption. The server returns within `waitMs` plus bounded network/serialization overhead. Idle `{version,kind:"idle",retryAfterMs}` requires 250–30000 ms minimum pacing, which hints cannot bypass. Dispatch eligibility and acquisition latency are distinct; there is no instant-delivery guarantee.

A claim contains exactly these required fields, plus optional `verificationUrl`:

| Field                                | V2 rule                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `version`                            | Exactly `ntapi.listener.v2`                                                               |
| `kind`                               | Exactly `claim`                                                                           |
| `sessionId`                          | UUID of the owning session                                                                |
| `deliveryId`, `attemptId`, `eventId` | 1–128 `[A-Za-z0-9_-]` characters; opaque identifiers                                      |
| `attempt`                            | Integer 1–1,000,000; durable attempt number                                               |
| `eventType`                          | 1–128 `[A-Za-z0-9_.-]` characters                                                         |
| `claimToken`                         | Secret lease capability, 16–256 `[A-Za-z0-9_-]` characters                                |
| `generation`                         | Positive integer at most `Number.MAX_SAFE_INTEGER`                                        |
| `dispatchAt`, `expiresAt`            | UTC ISO timestamps; dispatch at most 1 second ahead of client clock                       |
| `bodyBase64`                         | Canonical RFC 4648 standard alphabet/padding, no whitespace; at most 1,398,104 characters |
| `bodySha256`                         | Lowercase hex SHA-256 of decoded bytes                                                    |
| `bodyBytes`                          | Integer 0–1,048,576; empty allowed                                                        |
| `method`                             | Required, exactly `POST`; no other methods or overrides                                   |
| `headers`                            | Required list of 0–24 `[name,value]` pairs under the rules below                          |
| `verificationUrl`                    | Optional canonical HTTPS signing input, at most 2048 ASCII bytes                          |

No claim supplies a forwarding URL, proxy, Host or route override. `eventType` and module never determine payload/header validity. The body is canonical Base64 of **the original outbound bytes**, 0–1,048,576 bytes, with matching count and lowercase hex SHA-256. Decode, re-encode comparison, count and digest validation all occur before local I/O. There is no payload parsing, charset conversion, JSON/form serialization, decompression or signature validation in the CLI. The maximum complete cloud response remains 1,450,000 bytes.

A lease is at most 120 seconds and cannot exceed session expiry. More than local deadline + 1000 ms must remain before forwarding; otherwise the CLI stops without local execution or ACK. There is no claim renewal. Local total deadlines default to 10000 ms and cap at 30000 ms; connection/header deadlines are separately 2000/5000 ms, capped by total deadline. Wire deadlines use wall-clock times, so clocks must be synchronized.

Only one unacknowledged claim is outstanding per session. A lost claim response recovers through bounded lease expiry or an **identical** claim, including bytes, headers, metadata and lease. A known attempt/generation reuses cached ACK evidence without executing locally again. Changing capability/delivery identity for that cached pair, or reusing an attempt ID with a new generation in the same session, is terminal. Redelivery uses a **new attempt ID**; stale generations cannot authorize ACKs or execution.

See [wire examples](fixtures/v2.json), [generated JSON schema](protocol-v2.schema.json) and the exported `/protocol-v2` validators. JSON schema captures structural bounds; case-insensitive uniqueness, aggregate bytes, the safety denylist, exact canonical URL and body integrity also require runtime validation. JSON schema alone is insufficient.

## Header contract and threat model

The server selects admissible provider-generated end-to-end headers under a controlled server policy. The CLI independently enforces generic safety rules even against a compromised service. Adding a provider or ordinary custom signature/correlation header changes only the server policy, never a CLI allowlist.

- Names are nonempty HTTP tokens (`!#$%&'*+.^_` plus backtick, vertical bar, tilde, alphanumeric and hyphen), at most 64 ASCII bytes. Values are **printable ASCII only**, 0x20–0x7E, 0–1024 bytes. Reject CR, LF, NUL, HTAB, other controls, DEL, non-ASCII and unrepresentable values; never replace or silently encode them.
- At most 24 pairs and 8192 aggregate bytes, counted as the sum of name and value bytes, excluding wire separators. Reject rather than truncate. Case-insensitive duplicate names are forbidden. Header name casing and values are preserved on the wire; no comma joining, trimming or signature normalization. Ordinary HTTP receiver parsers may remove surrounding optional whitespace; tests also inspect the raw socket to prove wire fidelity.
- `content-type` is optional and opaque. Absence stays absent; no default JSON/form type is injected. The HTTP library creates Host, connection framing and Content-Length from the fixed local URL and decoded bytes.
- Deny exact names (case-insensitively): `host`, `content-length`, `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`, `keep-alive`, `authorization`, `cookie`, `set-cookie`, `forwarded`, `via`, `expect`, `content-encoding`, `accept-encoding`, `www-authenticate`, `authentication-info`, `max-forwards`, `x-http-method`, `x-http-method-override`, `x-method-override`, `x-real-ip`, `x-url-scheme`, `front-end-https`.
- Deny prefixes: `proxy-`, `x-forwarded-`, `sec-`, `x-original-`, `x-rewrite-`, `x-ntapi-listener-`. Thus Proxy-Authorization/Proxy-Authenticate, browser/WebSocket security fields, common routing and protocol overrides, and the entire CLI metadata namespace are unavailable to cloud provider headers. `Connection` itself is forbidden, so claims cannot nominate additional hop-by-hop fields.

`Expect` can change transmission and handshake behavior and is refused. Compression is outside this capability: all `content-encoding` values (even identity) are refused, as is `accept-encoding`; do not emit compressed bodies while suppressing their encoding header. `Sec-*` cannot confer browser or WebSocket authority. This is bounded webhook delivery, not an HTTP tunnel. A trusted server must also reject provider/custom headers that its application interprets as credentials, routing or overrides beyond this generic denylist. Arbitrary custom authentication such as a registered Dataverse header is inherently a secret intended for the opted-in local receiver; generic names cannot reveal every application's semantics.

Malformed structural/header/URL claims terminate without ACK or local I/O. A structurally valid claim with invalid Base64/count/digest receives `invalid_payload` evidence without forwarding. Neither case logs hostile content. Server poison retention must bound recurrence.

## Canonical public signing URL

`verificationUrl` is the exact saved canonical public URL actually used by the cloud signer, including path, percent encoding, query order and query bytes. Require absolute HTTPS, printable ASCII without whitespace/controls, valid percent escapes, no userinfo (including empty userinfo), no fragment (including empty `#`), and exact equality to WHATWG `new URL(value).href`. This rejects normalization changes instead of silently changing signing input. Unicode host/path/query must already have canonical punycode/percent serialization. The server must canonicalize **before signing**, persist that exact serialization, and populate metadata from it; caller-supplied Host/Forwarded headers are not evidence. If old noncanonical signing input cannot satisfy this rule, do not advertise URL-bound delivery until the server signer/storage is corrected.

Metadata is never dereferenced. It can name a private HTTPS host; this grants **no egress permission**. The sole destination remains fixed numerical loopback. The CLI does not rewrite Host/Forwarded to make provider verification succeed.

By default metadata is withheld from the handler. `--include-verification-url` explicitly discloses it only to the fixed local handler as `x-ntapi-listener-verification-url`. Missing metadata produces no header. The server cannot spoof that header through `headers`; the entire namespace is reserved. The metadata header is separate from provider pairs and does not consume their 24/8192 budgets (its own 2048-byte cap keeps the total bounded). The handler must trust this convention only on its dedicated local development route, never on an untrusted public route.

Example receiver logic: read raw bytes, read `x-ntapi-listener-verification-url`, then pass that URL plus the provider headers/raw bytes (or provider-required form fields) and the event source's signing secret to the provider SDK. Use fabricated secrets for local fixtures. Apply any provider-required canonicalization **in the handler**. Twilio/HubSpot signatures fail if localhost replaces their signing URL. Neither CLI metadata nor SHA-256 proves a provider signature. The server-supplied URL is informational signing context, so SDK verification and handler event deduplication remain required.

Signing URLs may contain private paths/query values. They never appear in routine text/JSON output, exceptions surfaced by the executable, or ACK evidence. Opt-in exposes them to any process owning the selected loopback port; secure that receiver and its logs. No metadata is stored on disk.

## ACK evidence, recovery and errors

After interpreting the full local response, the client generates one random UUID `ackKey` and POSTs `{version,sessionId,deliveryId,attemptId,claimToken,generation,ackKey,outcome}`. Identity/capability fields have the claim's bounds. Every retry uses identical evidence and key. A receipt is exactly `{version,ackKey,receipt:"recorded"}` with the matching key. It confirms recorded evidence, including local failure, rather than successful local delivery. Claiming/downloading alone is never acknowledgement.

The service checks current grant/scope/session ownership, capability, generation, association and expiry before recording evidence. A changed ACK under the same key is 409 `stale_claim`. Exact duplicates return the original receipt even after claim expiry while the token/session remain valid. Idempotency records survive for at least the session lifetime plus a bounded retry/retention policy. An unrecorded ACK after lease expiry is 410 `claim_expired`.

`outcome` contains exactly:

| Field                             | Meaning / bound                                                             |
| --------------------------------- | --------------------------------------------------------------------------- |
| `classification`                  | `success`, `http_error`, `connection_error`, `uncertain`, `invalid_payload` |
| `status`                          | Integer 100–599, or null                                                    |
| `durationMs`                      | Integer 0–120000; rounded elapsed local time                                |
| `requestBytes`                    | Integer 0–1048576; intended bytes if transmitted, not proof of receipt      |
| `responseBytes`                   | Integer 0–65536; observed count, a lower bound on truncation/abort          |
| `responseComplete`, `truncated`   | Boolean HTTP-framing completeness and overflow indication                   |
| `error`                           | `none`, `timeout`, `aborted`, `socket`, `response_limit`, `validation`      |
| `responseHeaders`, `responseBody` | Always `[]` and `""`; local response content never leaves the CLI           |

`success` requires complete 2xx, `error:"none"` and no truncation. Complete non-2xx is `http_error`; redirects are never followed. Connection/TLS failure before transmission is `connection_error` with null status and zero request bytes. Timeout, disconnect, cancellation or response overflow after transmission is `uncertain`, even after 2xx headers. `invalid_payload` uses null status, `error:"validation"`, zero duration/counts and false completeness/truncation; nothing was forwarded. Incomplete outcomes require a non-`none` error. The exported `consistentOutcome` helper checks logical consistency beyond structural schemas.

`ack_pending` emits sanitized evidence before upload; `ack_unconfirmed` preserves essentials on failure. No payload, signature, capability, auth token, full URL or arbitrary remote error text appears in normal output. Repeated identical claims reuse ACKs with 250 ms pacing; more than eight consecutive duplicates terminate the run. There is no disk spool or cross-process replay. A crash, lost claim response, lease expiry or restart may cause another execution. Delivery is **at least once**; handler deduplication remains mandatory.

| HTTP    | Error code(s)                                         | Behavior                                                                    |
| ------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| 401     | `unauthorized`                                        | Stop with exit 3: invalid/expired/revoked token                             |
| 403     | `forbidden`                                           | Stop with exit 3: denied scope or unavailable feature                       |
| 404     | `not_found`                                           | Stop: route/session missing                                                 |
| 409     | `session_conflict`, `stale_claim`, `version_mismatch` | Stop without takeover or local replay                                       |
| 410     | `session_expired`                                     | Only from poll: fresh session after 250 ms, at most 8 consecutive refreshes |
| 410     | `claim_expired`                                       | Stop; retain unconfirmed evidence                                           |
| 429     | `rate_limited`                                        | Retry with Retry-After and jitter                                           |
| 500–599 | `unavailable`                                         | Retry with backoff                                                          |

Incompatible status/code pairs and malformed/version-mismatched errors terminate the run. Network loss/timeouts are retryable, with at most eight retries per operation. Equal jitter is `[base/2,base]`, with exponential base initially 500 ms and a default 30000 ms cap. Retry-After integer seconds or HTTP date prevents earlier retries; a value over 60 seconds stops the run. ACK retries also stop at lease expiry with unchanged evidence/key. Definitive non-auth ACK rejection exits 5; auth denial exits 3. Ctrl+C/SIGTERM cancels requests and waits; local cancellation retains uncertainty and never reports false success.

The service owns bounded retention, retry limits, quotas, poison handling and terminal expiry, including offline listeners. The proposed service policy limits pending retention to 15 minutes from dispatch eligibility and delivery to 8 attempts; these values describe proposed contract policy, not verified hosted behavior. Polling/restarts must not extend retention, leases cannot exceed it, and terminal expiry retains an outcome record. The CLI supplies no global retention guarantee, and the in-memory reference fixture is not durable storage. Local tests establish client behavior, not hosted service acceptance.

## Forwarding, notifications and permanent acceptance

The fixed local target accepts only literal `localhost`, `127.0.0.1` or `[::1]` with HTTP(S). Localhost is mapped to numerical IPv4 without DNS. URL credentials, fragments, alternate IP spellings and other destinations are rejected. Paths/queries are fixed for the run. HTTPS validates the numerical host's certificate; there is no TLS bypass. Proxy environment variables are ignored, redirects are never followed, response-header parsing caps at 16 KiB and local response content is discarded after bounded collection.

Notifications remain **`ntapi.listener.notify.v1`**, specified in the [notification contract](listener-notifications-v1.md), with unchanged routes/ticket/credential-free hint frames and a 60-second HTTPS safety probe. HTTPS registration, claims, ACKs and close remain authoritative. Socket failure resumes bounded HTTPS polling without discarding session or ACK evidence. The notification service resolves the session's stored delivery version; no provider or version negotiation is added to socket frames.

`--once` exits after one claim and its ACK receipt (0 for local success, 5 for failure/uncertainty), or exits 4 after one idle HTTPS response by default. `--max-idle-polls N` counts idle HTTPS responses, never hints; 0 waits indefinitely. Continuous mode reports local outcomes and continues. Usage errors exit 2, transport/protocol errors generally exit 1, and cancellation exits 130. See the [CLI guide](../README.md) for operator configuration and the [security model](security.md) for trust boundaries.

`provider-agnostic-contract` is a permanent CI gate. A reference cloud delivers two entirely unfamiliar changing signature/timestamp/correlation header sets across JSON, form, binary and absent media types to both the built executable and the freshly installed tarball. Exact body/header receipt, SDK checks for actual provider fixtures, one local effect and lost-ACK recovery must pass without changing production source. The existing durability/notification suites also run with V2 selected.

**Definitive invariant:** adding an ordinary HTTPS POST callback provider that fits this envelope requires zero changes to CLI source, protocol enumerations or release version. Different protocols (gRPC, bidirectional streaming), non-ASCII header representations, compressed bodies, additional methods or larger limits require explicit transport design/review. Provider agnosticism does not promise every network protocol.
