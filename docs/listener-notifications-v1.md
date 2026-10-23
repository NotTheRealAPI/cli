# Listener notifications V1

Wire version: **`ntapi.listener.notify.v1`**, independent of [HTTP delivery V1](listener-protocol-v1.md) and [V2](listener-protocol-v2.md). The CLI implements this optional channel; Production hosted listeners are not currently enabled. It carries hints only: registration, fenced claims, byte validation, local delivery, ACK retries and durable receipts remain on HTTPS. No webhook data or delivery authority is conveyed by a hint.

## Ticket and socket

Register a session through the explicitly selected HTTP delivery version first. The service resolves its stored session version without adding delivery-version or provider fields to notification frames. POST `/listener/notify/v1/tickets` at the configured API origin with `Authorization: Bearer <scoped listener token>`, `Content-Type: application/json`, `Accept: application/json` and `X-NTAPI-Listener-Notify-Version: ntapi.listener.notify.v1`. The body is exactly:

```json
{
  "version": "ntapi.listener.notify.v1",
  "sessionId": "00000000-0000-4000-8000-000000000001"
}
```

HTTP 200 JSON contains exactly `version`, `ticket`, `expiresAt`. The opaque ticket starts with `ntapi_nt_` and has 43 base64url characters after that marker. It is single-use and expires within 30 seconds, bounded by grant and session expiry. The CLI validates the envelope and remaining lifetime and never reuses a ticket. Ticket values must never appear in output, examples or process arguments.

Open `/listener/notify/v1/socket` on the same API host and port, mapping HTTPS to WSS. Only explicitly permitted loopback HTTP testing maps to WS. There are no query credentials, Authorization headers, cookies or subprotocols in the upgrade. Redirects, cross-origin follow and TLS downgrades are refused on both channels. TLS verification remains enabled.

Immediately after opening, send one text JSON envelope with exactly `version` and the one-use `ticket`, within five seconds. Send no further application frames. The CLI also disables automatic pong replies. Handshake and initial ready each have a deadline of the configured cloud timeout or five seconds, whichever is shorter. No connection is healthy until a valid `ready` arrives. A socket is forcibly retired after 240 seconds even if the peer sends no close. Shutdown terminates sockets without waiting for a close handshake.

Server text frames are exactly `{version:"ntapi.listener.notify.v1",event:"ready"|"resync"|"closing"}`. Unknown keys/events, binary frames, invalid UTF-8/JSON, oversized frames and invalid transitions retire the channel safely. Ticket responses and server messages are bounded to 1024 bytes; compression is disabled. A second `ready`, or `resync`/`closing` before `ready`, is invalid. Raw frames, remote error text and credentials are never included in diagnostics.

## Scheduling and recovery

Every `ready` (including reconnect) triggers an HTTPS claim probe, recovering events created before subscription. `resync` wakes the same loop. A single pending latch coalesces hints; hints arriving during local delivery or ACK retries survive until the next probe. One claim/local request/ACK chain runs at a time. After ACK confirmation, probe again immediately and drain eligible work until idle. Idle responses enforce their minimum `retryAfterMs` pacing even when hints arrive.

Healthy idle listeners probe within 60 seconds of the last probe even without hints. Session renewal occurs before expiry using the same session ID, including during long idle periods. Active HTTP/local requests and existing retry deadlines still apply; safety probes never compete with an in-flight delivery/ACK. A changed session closes the old socket and obtains a fresh ticket for the new identity. Stale socket callbacks are ignored.

Socket closing/disconnection, timeout, malformed messages and transient network/service failures resume HTTP polling and schedule a fresh ticket with equal jitter, a one-second minimum and a 30-second maximum backoff. Unsupported ticket routes (404/405/501), known feature-not-configured responses and older HTTP V1 reference-fixture denials use a 60-second retry. Retry-After may extend a transient retry to 60 seconds. Ticket authentication/scope denials (401/403) are terminal. An HTTP V1 reference-fixture denial is only a compatibility fallback; the next authoritative HTTP operation must still authenticate. No Redis client is required.

Socket failure does not close/fence a durable session, clear duplicate evidence or discard a pending ACK. Cancellation aborts HTTP, socket establishment and waits; existing ACK uncertainty and best-effort close rules remain unchanged. JSON reporting adds `notifications_ready` and `notifications_fallback` (`reason` is `unsupported` or `unavailable`, with `retryMs`).

## Finite runs

`--once` processes one claim through its local outcome and ACK receipt, or exits 4 after one idle HTTPS response by default. It does not wait forever for a socket hint. `--max-idle-polls N` counts idle HTTPS responses only; notification messages do not increment/reset that count. With healthy notifications, subsequent probes wait for hints or the safety interval, so elapsed time depends on channel health. Explicit `--max-idle-polls 0` allows indefinite event waiting; cancellation still exits promptly. A successful claim resets the idle count. All existing exit codes and local transport classifications are preserved.
