# Listener delivery V2

Wire version **`ntapi.listener.v2`**, CLI release candidate **0.2.0**. This is a client contract and local reference implementation. The current hosted service implements Stripe-only V1; this document does not assert hosted V2 availability. See [the server implementation handoff](SAAS-V2-HANDOFF.md).

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

At the configured API origin use these POST routes with JSON and `X-NTAPI-Listener-Version: ntapi.listener.v2` and the same scoped Bearer grant:

| Route                                     | Request                                                                         | HTTP 200 response                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `/listener/v2/sessions`                   | `{version,sessionId,scope}`                                                     | `{version,sessionId,scope,expiresAt}`                |
| `/listener/v2/sessions/:sessionId/claims` | `{version,waitMs}`                                                              | Claim below, or `{version,kind:"idle",retryAfterMs}` |
| `/listener/v2/sessions/:sessionId/acks`   | `{version,sessionId,deliveryId,attemptId,claimToken,generation,ackKey,outcome}` | `{version,ackKey,receipt:"recorded"}`                |
| `/listener/v2/sessions/:sessionId/close`  | `{version}`                                                                     | `{version,closed:true}`                              |

All objects are strict; unknown properties are rejected. Every envelope, including errors, uses the selected version. Errors, allowed HTTP/code pairs, scope, IDs, times, leases, retry/Retry-After behavior, renewal and outcomes have the [V1 semantics and bounds](listener-protocol-v1.md), with only their version literal replaced. Error bodies are exactly `{version,code}`. Valid 401/403 errors stop with exit 3. A response in a different version stops as a protocol error, including error responses.

Scope remains `{module,environment,destination}`. Module is an opaque grant/routing identifier, independent of provider metadata. Environment chooses grant scope, never the API host or provider policy. Destination is SHA-256 of the normalized fixed `--forward-to` URL. The server verifies user/workspace, route, module, environment, destination, action, expiry, revocation and feature gate on **every** operation. No body digest or CLI token prefix proves provider authenticity or server-side authorization.

One active listener per user must be enforced atomically across **both versions**. One outstanding claim, unique attempt IDs, monotonic generation fencing, identical lost-claim replay, idempotent ACK and changed-ACK rejection remain mandatory. Keep the same ownership/capability/TTL checks through session renewal. ACK means recorded evidence, including local failure, never implicit local success. There is no client disk spool. Delivery remains at least once; handlers deduplicate event IDs.

## V2 claim delta

Start with the V1 claim's exact identity/lease/body fields: `version`, `kind`, `sessionId`, `deliveryId`, `attemptId`, `attempt`, `eventId`, `eventType`, `claimToken`, `generation`, `expiresAt`, `dispatchAt`, `bodyBase64`, `bodySha256`, `bodyBytes`. V2 changes only:

| Field             | V2 rule                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `version`         | Exactly `ntapi.listener.v2`                                      |
| `method`          | Required, exactly `POST`; no other methods or overrides          |
| `headers`         | Required list of 0–24 `[name,value]` pairs under the rules below |
| `verificationUrl` | Optional canonical HTTPS signing input, at most 2048 ASCII bytes |

No claim supplies a forwarding URL, proxy, Host or route override. `eventType` and module never determine payload/header validity. The body is canonical Base64 of **the original outbound bytes**, 0–1,048,576 bytes, with matching count and lowercase hex SHA-256. Decode, re-encode comparison, count and digest validation all occur before local I/O. There is no payload parsing, charset conversion, JSON/form serialization, decompression or signature validation in the CLI. The maximum complete cloud response remains 1,450,000 bytes.

See [executable examples](fixtures/v2.json), [generated JSON schema](protocol-v2.schema.json) and `src/protocol-v2.ts`. JSON schema captures structural bounds; case-insensitive uniqueness, aggregate bytes, the safety denylist, exact canonical URL and body integrity also require runtime validation. JSON schema alone is insufficient.

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

Example receiver logic: read raw bytes, read `x-ntapi-listener-verification-url`, then pass that URL plus the provider headers/raw bytes (or provider-required form fields) and synthetic secret to the provider SDK. Apply any provider-required canonicalization **in the handler**. Twilio/HubSpot signatures fail if localhost replaces their signing URL. Neither CLI metadata nor SHA-256 proves a provider signature. The server-supplied URL is informational signing context, so SDK verification and handler event deduplication remain required.

Signing URLs may contain private paths/query values. They never appear in routine text/JSON output, exceptions surfaced by the executable, or ACK evidence. Opt-in exposes them to any process owning the selected loopback port; secure that receiver and its logs. No metadata is stored on disk.

## Forwarding, notifications and permanent acceptance

Loopback-only targets, localhost normalization, destination digest binding, TLS validation, no redirects/proxies, 30-second local cap, connection/header deadlines, bounded response collection, sanitized evidence and shutdown behavior are identical to V1. Notifications remain **`ntapi.listener.notify.v1`** with unchanged routes/ticket/credential-free hint frames and a 60-second HTTPS safety probe. The notification service resolves the session's stored delivery version; no provider or version negotiation is added to socket frames.

`provider-agnostic-contract` is a permanent CI gate. A reference cloud delivers two entirely unfamiliar changing signature/timestamp/correlation header sets across JSON, form, binary and absent media types to both the built executable and the freshly installed tarball. Exact body/header receipt, SDK checks for actual provider fixtures, one local effect and lost-ACK recovery must pass without changing production source. The existing durability/notification suites also run with V2 selected.

**Definitive invariant:** adding an ordinary HTTPS POST callback provider that fits this envelope requires zero changes to CLI source, protocol enumerations or release version. Different protocols (gRPC, bidirectional streaming), non-ASCII header representations, compressed bodies, additional methods or larger limits require explicit transport design/review. Provider agnosticism does not promise every network protocol.
