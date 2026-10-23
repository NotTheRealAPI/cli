# Changelog

## 0.2.0 — unreleased candidate

- Provider-neutral V2: exact opaque bodies, POST, bounded generic safe headers and optional canonical signing URL metadata disclosed to the handler only by opt-in.
- V2 executable default; explicit `--protocol v1` retains the unchanged 0.1.0 Stripe contract. No automatic downgrade. Separate protocol exports, schemas and fixtures share one forwarding/ACK engine.
- Permanent provider-agnostic-contract gate, independent SDK verification fixtures, V2 durability/notification suite and installed-tarball acceptance across the six CI jobs.
- Self-contained public V2 contract, explicit V1 upgrade guidance and package checks that exclude private operational material and broken documentation links. Hosted V2 requires a compatible server deployment; this candidate does not establish hosted availability.

## 0.1.0 — 2026-10-22

Initial release of `@nottherealapi/cli`.

- Listener V1 registration, fenced claims, byte-preserving loopback forwarding, bounded retries, ACK evidence and session close.
- Optional WebSocket notification hints with 60-second idle safety probes and authoritative HTTPS fallback.
- Scoped environment tokens, protected POSIX token files, sanitized diagnostics and JSON output.
- ESM exports, TypeScript declarations, protocol schemas, synthetic local demo and packed HTTPS/WSS smoke coverage on Windows, macOS and Linux with Node 22.13.0 and 24.

Production hosted listeners are not currently enabled. Publishing this CLI does not enable hosted access.
