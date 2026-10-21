# Development, checks and release

Work only in the public `NotTheRealAPI/cli` repository. No private SaaS, examples, Vercel or Neon changes are needed. All fixtures are synthetic. Node **22.13.0+**, npm 10+; CI explicitly covers 22.13.0 and the Node 24 LTS line on Windows, macOS and Linux. [Node release status](https://nodejs.org/en/about/previous-releases) identifies 22/24 as supported LTS lines at implementation time.

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run format:check
npm run pack:smoke
npm audit --audit-level=high
npm run demo
```

`npm test` compiles strict TypeScript, regenerates JSON Schema and runs Node's test runner. Tests bind numerical loopback only; a sandbox/firewall must allow outbound loopback sockets. No cloud credentials, public ingress, real Stripe account, paid infrastructure or minute-scale waits are required. Idle/backoff/renewal tests inject an accelerated clock. Connection-deadline coverage uses an injected unconnected socket, because a real loopback refusal is immediate; real refusal/response/socket tests use actual servers. POSIX validates token file owner/mode/symlink handling; Windows asserts the explicit environment-only policy. IPv6 test can skip only when the OS lacks IPv6; that skip must be reported. A Windows `child.kill('SIGTERM')` uses TerminateProcess and cannot prove a catchable Unix signal; AbortSignal integration tests cover graceful in-flight cancellation on every OS, and Unix subprocess tests assert exit 130.

`npm run pack:smoke` requires a preceding build/test and npm 10+. It packs with the explicit files allowlist, installs the archive with **offline** cached dependencies in an isolated temporary consumer, and executes the installed bin through `npm exec`. It verifies source/tests/scripts are excluded, then removes the verified temporary directory. `npm pack` normally runs the build through prepack. No publishing lifecycle is configured.

Architecture:

| Source         | Responsibility                                                      |
| -------------- | ------------------------------------------------------------------- |
| `cli.ts`       | Grammar/help/version, signal lifecycle and safe exit mapping        |
| `config.ts`    | Environment/file auth, URL pinning, scope digest and numeric bounds |
| `protocol.ts`  | Versioned strict schemas, byte/header validation, public types      |
| `client.ts`    | Bounded authenticated protocol requests, typed errors, Retry-After  |
| `transport.ts` | Native byte-exact HTTP(S), no redirects/proxies, finite bounds      |
| `listener.ts`  | Single-delivery state machine, leases, ACK idempotency, retries     |
| `output.ts`    | Explicit metadata fields and versioned JSON/text                    |

ESM avoids dual builds; compiled JS/declarations are exported for independent protocol/system tests. Zod is the sole runtime dependency and generates the shipped JSON Schema. Node APIs provide argument parsing, crypto, sockets, cancellation and testing. Dev dependencies are TypeScript, Node type declarations, ESLint/TypeScript ESLint and Prettier. The committed npm lockfile is reproducible. The package contains no private imports or provider SDK dependency; independent HMAC verification lives only in fixtures/tests/demo.

Edit `src/protocol.ts`, rebuild the schema, and explicitly review any resulting contract diff. CI checks that regenerated `docs/protocol-v1.schema.json` matches Git. Update wire examples, client, fixture enforcement, protocol docs and handoff together. A backend contract change must not silently change V1.

CI runs build/test, lint, format, schema drift, archive/bin smoke and dependency audit across six OS/Node jobs. It has read-only repository permissions and no publish credentials. Dependabot proposes npm/action updates. Tests report meaningful assertions/case counts, including a real executable subprocess, not just exit 0.

## Deliberately gated release

1. Confirm the candidate protocol, canonical hosted origin, backend availability and token issuance with the owner. Complete Part 2's actual Preview acceptance checks before making live integration claims.
2. With the owner's authenticated npm account, verify ownership of `@nottherealapi`, organisation role and package publishing permission (`npm whoami`, `npm org ls nottherealapi`, and owner review in npm settings). A registry 404 does not prove namespace availability/ownership.
3. Review files with `npm pack --dry-run`, run the complete matrix, audit dependencies and inspect the packed executable. Verify version/license/repository metadata and documented security limitations.
4. Obtain explicit owner approval before any `npm publish`, tag, GitHub release or package credential creation. Prefer npm trusted publishing when a separately approved release workflow is designed. No publish workflow exists here.

Implementation-time checks on 2026-10-21: the public registry returned **404** for `@nottherealapi/cli`; `npm whoami` returned **ENEEDAUTH**. Organisation ownership/publish permission cannot be established anonymously and remain a release blocker. Nothing was published or registered. See [review evidence](REVIEW.md) for measured checks and platform status.
