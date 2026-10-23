# Security and privacy

## Trust boundaries

The CLI accepts events from an authenticated listener service and treats envelopes, headers and body bytes as untrusted input. Relevant threats include stolen tokens, scope confusion, SSRF, DNS rebinding, proxy routing, malicious payloads, response-data leaks, redirects, duplicate effects and stale claims.

Only literal `localhost`, `127.0.0.1`, and `[::1]` forwarding targets are accepted. Localhost is converted to numerical IPv4 without a DNS lookup; IPv6 is explicit. LAN, metadata and public addresses, alternate integer/octal/mapped IP spellings, URL credentials, fragments and other schemes are rejected. The service cannot supply or change the destination.

Native HTTP(S) requests do not use proxy environment variables, follow redirects, serialize the local request body or transparently decompress responses. The CLI opens no inbound listener. HTTPS validates the numerical host's certificate identity, and TLS bypass configuration is rejected. A custom API origin is a trust decision: only send a token to the service that issued it. HTTP API access requires an explicit loopback-only option.

## Payloads and evidence

The optional notification channel carries no webhook data or delivery authority. It uses a short-lived, single-use ticket obtained over authenticated HTTPS after session registration. The WebSocket upgrade contains no credentials or subprotocol. Both channels stay at the configured origin and refuse redirects and TLS downgrades. Notification frames are strictly validated, capped at 1024 bytes and omitted from diagnostics. Lost hints are covered by a 60-second idle safety probe; notification failure resumes authoritative HTTP polling without replacing the session or discarding ACK evidence. The listener contract permits one active session per user; the CLI never evicts another listener.

Before opening a local request, the CLI checks canonical Base64, byte count and SHA-256. V1 admits only its frozen Stripe headers. [V2](listener-protocol-v2.md) independently validates generic HTTP token names, printable ASCII values, case-insensitive uniqueness and finite count/byte bounds against a provider-neutral transport/security denylist. The server remains responsible for provider and custom-header policy. Unknown ordinary signature/correlation names need no CLI registration. It recomputes Content-Length and preserves the signature value. Bodies remain opaque bytes, including binary and empty bodies.

The local handler must independently verify the signature using raw bytes and a synthetic test signing secret from the event source. Provider signing secrets are not CLI credentials. Handlers must deduplicate provider event IDs.

Limits include a 1 MiB decoded payload, 1,450,000-byte cloud JSON response, 16 KiB parsed response headers, V1: three headers with 8192-character values; V2: 24 pairs, 64-byte names, 1024-byte values, 8192 aggregate name/value bytes and an optional 2048-byte signing URL, a 64 KiB observed local response, one active claim and 256 cached ACKs per session. Total request deadlines cap at 30 seconds. Oversized or incomplete local responses after transmission are classified as uncertain, not successful.

Local response headers and bodies are discarded before uplink. Evidence contains only status, byte counts, duration, completeness and enumerated errors. Content-based redaction cannot reliably remove arbitrary secrets from excerpts. Normal diagnostics omit full URLs, bodies, signature headers and credentials. No telemetry, payload debug mode or automatic request capture is provided. Event identifiers and other operational metadata can still be sensitive; protect captured output.

## V2 version and signing-context boundaries

The executable defaults to V2 and never automatically downgrades. Existing V1-only services require explicit `--protocol v1`; 401/403, timeout, malformed/version-mismatched responses and redirects cannot alter that selection. Published V1 schemas/fixtures stay frozen. Library root exports and the three-argument ProtocolClient retain V1; V2 uses its own explicit export/constructor mode.

V2 refuses framing, hop-by-hop, routing/forwarded/proxy, standard credential/cookie, method-override and Sec-* headers. Expect and both Content-Encoding/Accept-Encoding are rejected; compressed delivery is outside this capability. Connection cannot nominate other hop-by-hop fields because Connection itself is forbidden. Reserved x-ntapi-listener-* provider headers are always rejected. Custom auth headers inherently disclose their configured synthetic secret to the chosen handler; server policy must review application-specific credential/routing semantics that generic names cannot reveal.

Optional verificationUrl is exact canonical absolute HTTPS signing context, never a request destination. The server must derive it from the actual saved public URL used by its signer, never original caller headers. ASCII/length/credentials/fragment/serialization checks prevent silent changes. It is withheld from the handler unless --include-verification-url is selected; the dedicated x-ntapi-listener-verification-url header cannot collide with provider headers. A private URL may be disclosed to the selected loopback process, so protect that port and handler logs. Never trust this local metadata convention on public routes. URLs remain absent from routine CLI diagnostics and ACK evidence. Provider SDK verification uses the synthetic key and, where necessary, this public signing URL rather than localhost.

The permanent provider-agnostic-contract gate tests changing unknown header sets, official provider SDK verification and forbidden-header rejection before local I/O. JSON schema does not express every runtime rule; retain denylist, duplicate/aggregate, URL, body integrity, scope and lease validation. See the exact V2 contract for the security policy and capability limits.

## Credentials

Prefer ephemeral environment injection. Environment values can be inspected by processes with sufficient OS privileges and are inherited by children. Clear them after use. Command-line tokens are visible in process listings and can enter shell history.

POSIX token files use no-follow descriptor reads with owner, mode and size checks. Windows rejects token files because POSIX mode bits do not establish Windows ACL protection. There is no automatic credential persistence or keychain integration.

The token prefix only identifies its format. A compatible service must verify scope, expiry and revocation on every operation, including repeated ACKs and session close. The destination digest binds a canonical URL to the token scope; it is not encryption, and guessable routes can be recovered by enumeration.

## Delivery limitations

There is no durable client ACK spool. A crash, timeout or cancellation after transmission may leave a committed handler effect without a confirmed ACK. Restarting cannot replay a previous process's ACK, and delivery can occur again. Service-side fencing and idempotency do not replace handler deduplication. The service owns retention, retry limits and terminal expiry; the CLI provides no global retention guarantee.

The CLI does not isolate processes running as the developer, authenticate ownership of a loopback port or compensate for clock skew. A local process can impersonate the handler, and a user-selected malicious API can receive its configured token. Keep the host secure, select trusted service origins, synchronize the clock and protect local evidence files.

Follow [SECURITY.md](../SECURITY.md) to report a vulnerability.
