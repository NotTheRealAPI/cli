# Part 1 implementation and review record

Scope: public `NotTheRealAPI/cli` only, candidate package 0.1.0 and wire **`ntapi.listener.v1`**. Hosted Preview integration has **not** been exercised. No npm publication, tagged release, package credential, private SaaS, example repository, hosting, database, billing or Production change was made.

## Measured local evidence (2026-10-21)

Windows, Node v24.14.1, npm 11.11.0. Full suite result:

```text
1..116
# tests 116
# suites 0
# pass 116
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Strict TypeScript build, ESLint, Prettier check, schema generation and `git diff --check` passed. Dependency audit reported **0 vulnerabilities**, including development dependencies. The packed archive was installed offline in a temporary consumer; its installed executable passed `--help` and `--version`. The real demo subprocess received a reference-service event, independently verified its supplied signature on a loopback socket, returned 204 and uploaded a recorded success outcome. No externally deployed service or account credentials were used. Network sandboxing initially produced EACCES on loopback; socket checks ran with explicit loopback-capable execution.

| Coverage            | Evidence                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fidelity/signature  | Actual receiving sockets; UTF-8, whitespace, CRLF, binary, empty, full 1 MiB; independent HMAC, tampered signature/body rejection at handler                         |
| Local outcomes      | 200/204/400/429/500/302, no redirect, refusal, response deadline, truncated framing, post-request close, oversized response; no early ACK                            |
| Protocol boundaries | Wrong version, unknown fields, body/digest/Base64/count mismatch, duplicate/cased/header injection and unexpected metadata                                           |
| Cloud recovery      | Register/poll/ACK auth/conflict/expiry/rate/5xx/network faults, cloud poll/ACK deadline, lost recorded ACK receipt, same-key retry                                   |
| Ownership           | Scoped gate/actions/expiry/revocation, dual listener conflict, stale fencing, claim expiry, exact duplicate claim, changed generation, renewal                       |
| Boundedness         | Accelerated idle/backoff/Retry-After/retry exhaustion, ACK lease deadline, 257 actual claims across cache/session rotation                                           |
| Privacy/SSRF        | Token canaries in JSON/errors/metadata; malicious local response omitted; loopback/DNS spelling/credential/proxy restrictions, including Node environment-proxy mode |
| Shutdown/platform   | AbortSignal during real local request, actual subprocess termination, numerical IPv6 socket; Windows environment-token policy                                        |

Connection-timeout testing injects an unconnected socket; a live loopback refusal does not naturally hang. POSIX credential file ownership/mode/symlink checks run in Unix CI, while Windows checks the explicit rejection policy. On Windows, process-kill uses TerminateProcess and cannot demonstrate catchable Unix SIGTERM; graceful AbortSignal behavior is covered locally. Those distinctions are explicit, not mock-success claims.

## Platform matrix

`.github/workflows/ci.yml` runs all checks, 116 tests, archive/bin execution and audit on:

| Platform | Node            |
| -------- | --------------- |
| Windows  | 22.13.0, 24 LTS |
| macOS    | 22.13.0, 24 LTS |
| Linux    | 22.13.0, 24 LTS |

Only Windows/24 is measured locally in this record. Current remote results must be read from [the branch's Actions runs](https://github.com/NotTheRealAPI/cli/actions?query=branch%3Ainitial-cli) and reported with the final commit; configured jobs alone are not a pass. The checked-in record avoids assuming that remote jobs have run.

## Design/security review

The CLI has one runtime dependency (Zod), strict schemas/types and native bounded HTTP(S). No JSON parsing or serialization occurs on the local forwarding path. Only canonical Base64 decoding and digest/count/header validation precede raw-buffer transmission. Provider signatures are untouched. The service retains event ownership and signing; HMAC exists only in the public synthetic fixture/tests/demo.

Scope boundaries, numerical dialing, TLS validation, no proxy/redirect forwarding, HTTP framing bounds and omission of all response content were reviewed with adverse tests. ACK state retains the same capability/key/outcome across retries; no local execution follows receipt loss. No ACK before the full local response, and uncertain transmission stays uncertain. The client stops on credential/protocol/fencing failures. Duplicate caches rotate after 256 acknowledged attempts and duplicate-claim storms terminate after eight repeats with 250 ms pacing. No private code/dependency was imported. This is an implementation self-review plus executable adverse tests, not a third-party security audit.

Tradeoffs: single concurrency favors ordering and bounded state; short outbound polls incur requests/latency rather than continuous hosted execution; ephemeral credentials avoid misleading secure-storage claims; response excerpts are deliberately empty because unknown secrets cannot be reliably redacted; ACK state survives only in process and sanitized stdout. A crash can still cause duplicate effects. Capture protected JSON evidence if local crash-surviving logs are needed. Receiver deduplication is mandatory. Host clock synchronization, local port ownership, user-selected cloud trust and process-account security remain operational responsibilities.

## Files and dependency changes

Source: `src/{cli,config,protocol,client,transport,listener,output,index}.ts`. Tests: `test/{fixture,e2e.test,security.test}.mjs`. Tooling: `scripts/{schema,demo,pack-smoke}.mjs`, `package.json`, lockfile, strict tsconfig, ESLint/Prettier configuration, line endings/ignore files, CI and Dependabot. Docs: README, SECURITY, CONTRIBUTING, this report, protocol/schema/wire fixtures, security/development and standalone SaaS handoff. Existing MIT licence is retained.

Locked tooling at review: Zod 4.6.7 (sole runtime dependency); TypeScript 5.9.3, ESLint 10.13.0, typescript-eslint 8.72.0, Prettier 3.9.10, Node 22 type declarations. `package-lock.json` is authoritative.

The requested npm name returned registry 404; unauthenticated `npm whoami` returned ENEEDAUTH. Neither proves organisation ownership or publish permission. Owner-authenticated scope/role verification is a deliberately unresolved **release gate**, not a reason to invent availability or create credentials. No publish workflow exists.

Final grammar, quick start, sanitized success/failure examples and exit codes are in [README](../README.md). Exact server requirements and the later Preview harness acceptance checklist are in [SAAS-HANDOFF](SAAS-HANDOFF.md). Live authorization, durable retention, hosted restart/deployment boundaries and actual Preview delivery are Part 2, not verified Part 1 properties.
