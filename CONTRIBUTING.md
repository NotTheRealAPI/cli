# Contributing

Public pull requests are proposals. Maintainers decide what to merge and when to release; submitting a contribution does not grant merge or publishing access. Submit original code or code you have permission to contribute under the project's [MIT licence](LICENSE), and retain required third-party notices. No CLA or DCO signoff is required.

Use synthetic data in examples and tests. Do not commit credentials, personal data or third-party confidential material. Read the [V2 protocol specification](docs/listener-protocol-v2.md) and [frozen V1 contract](docs/listener-protocol-v1.md) and [security model](docs/security.md) before changing transport or authentication behavior.

Requires Node.js 22.13.0+ and npm 10+. Run these checks from the repository root:

```sh
npm ci --ignore-scripts
npm test
npm run test:v2-durability
npm run test:provider-agnostic-contract
npm run lint
npm run format:check
npm run demo
npm run pack:smoke
npm audit --audit-level=high
```

Tests and the demo use local loopback sockets and synthetic credentials. Allow loopback connections in your test environment. No hosted service or account credentials are needed. The connection-deadline test injects an unconnected socket; other forwarding tests use real HTTP servers. IPv6 coverage can skip if the OS lacks IPv6. Unix subprocess tests check graceful SIGTERM handling; Windows process termination is checked separately from graceful AbortSignal cancellation.

`test/fixtures/localhost-key.pem` and `localhost-cert.pem` are a deliberately public, synthetic loopback TLS fixture. The self-signed certificate identifies `synthetic-loopback-fixture` and has only `127.0.0.1` as its subject alternative name. The key provides no production identity or confidentiality. These fixed files keep HTTPS/WSS tests portable without an external certificate generator. The smoke subprocess trusts this certificate through `NODE_EXTRA_CA_CERTS`; tests do not install it into an OS trust store. Never reuse this key or trust this certificate outside the local fixture. Both files are excluded from the npm package by its file allowlist and the package smoke assertions.

`npm test` builds the executable, generates both versioned JSON schemas, and runs the tests. Changes to the generated schema must match the documented protocol. Include matching fixture and interoperability updates with any proposed protocol revision; do not silently change V1.

`npm run pack:smoke` requires a preceding build and cached dependencies from `npm ci`. It installs the archive offline in an isolated consumer using the locked runtime dependencies, executes the installed bin, ESM exports, declarations, V1 HTTPS/WSS smoke and provider-agnostic-contract fixtures with test-only official SDK verification, and removes the temporary consumer. Pass `-- --archive /absolute/path/to/package.tgz` to test an existing archive without repacking it. CI runs these checks and the demo on Windows, macOS and Linux with Node 22.13.0 and 24, with read-only repository permissions and no publishing credentials. Keep `@types/node` on major 22 to match the runtime minimum.

Describe the behavior affected by a pull request and the checks you ran. For vulnerabilities, follow [SECURITY.md](SECURITY.md).
