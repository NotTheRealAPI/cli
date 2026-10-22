# Historical npm readiness audit — @nottherealapi/cli 0.1.0

This is archived evidence from the readiness phase, not a live release-status report. Its commit, archive digest and checklist describe the earlier candidate, not the final release artefact. The owner subsequently confirmed retention of `Copyright (c) 2026 NotTheRealAPI` and MIT, npm organisation Owner access and enabled 2FA, and authorised the 0.1.0 publication, matching tag and GitHub release. Those decisions supersede the approval prerequisites below. Follow the [release runbook](npm-release.md); registry verification and the matching GitHub release establish completed publication.

Historical assessment on 22 October 2026: **NOT READY TO PUBLISH at that time**, pending the owner decisions now recorded above. Technical validation passed. No publication, tag, GitHub release, merge or hosted service validation was performed during that readiness phase. Production hosted listeners remain unavailable; CLI publication does not enable them.

## Exact candidate and archive

- Public repository: `NotTheRealAPI/cli`; branch: `npm-release-readiness`.
- Base: `4b77c0f8e6676f96e6687efff8fc0f313c9b5da2` (current `main` fetched before branching).
- Validated package-input commit: **`774461f8a1bba708a4ddc651d6b8e7f3e7468917`**. This report is a subsequent documentation-only commit excluded from the package. Any changed package input needs fresh validation.
- Toolchain: Windows x64, Node **24.14.1**, npm **11.11.0**. The shell initially selected npm 6.14.8; all accepted checks used npm bundled with Node 24. Local npm cache/logs and generated archives remain ignored under `.cache/`.
- Runtime requirement: Node `>=22.13.0`; tested OS/Node matrix below. Locked runtime dependencies: `ws` **8.22.0** and `zod` **4.6.7**, both MIT; `@types/node` stays **22.20.5**. No dependency versions or lockfile changed.
- Archive: `nottherealapi-cli-0.1.0.tgz`, **34,148 bytes**, **131,478 unpacked bytes**, **29 files**, no bundled dependencies.
- SHA-1: `e4589345ac31e00621ad0515f161530a53452b78`.
- Integrity: `sha512-7MP20k3DCJgy7mzYmlGAgGkcLCYfRoyH9Xu2JzfwLVOLEtHGLMj3BlrPVjIFFCbQy2cErh7g90I8gBpEOZZlbg==`.

The working-checkout pack and a separate clean local clone at the exact candidate commit produced identical archive integrity and inventory using the same toolchain and locked dependencies. The existing checkout initially had CRLF bytes in `LICENSE`, contrary to `.gitattributes`; normalising that working file to LF made it match the clean clone. Its Git contents and copyright wording did not change. Reproduce from a clean clone, not a potentially stale working tree.

Actual `npm pack --dry-run --json` and archive inventories match exactly (paths relative to `package/`):

```text
CHANGELOG.md
CONTRIBUTING.md
LICENSE
README.md
SECURITY.md
dist/cli.d.ts
dist/cli.js
dist/client.d.ts
dist/client.js
dist/config.d.ts
dist/config.js
dist/index.d.ts
dist/index.js
dist/listener.d.ts
dist/listener.js
dist/notifications.d.ts
dist/notifications.js
dist/output.d.ts
dist/output.js
dist/protocol.d.ts
dist/protocol.js
dist/transport.d.ts
dist/transport.js
docs/fixtures/v1.json
docs/listener-notifications-v1.md
docs/listener-protocol-v1.md
docs/protocol-v1.schema.json
docs/security.md
package.json
```

## Validation results

| Check                                                                                                                                      | Result                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `npm ci --ignore-scripts`                                                                                                                  | PASS; 102 locked dependencies installed, no lifecycle scripts                        |
| `npm run lint`, `npm run format:check`, `git diff --check`                                                                                 | PASS                                                                                 |
| `npm run build`                                                                                                                            | PASS; strict TypeScript build and schema generation                                  |
| `npm test`                                                                                                                                 | PASS; 163 tests, zero failures/skips locally                                         |
| `git diff --exit-code -- docs/protocol-v1.schema.json`                                                                                     | PASS; no wire/schema change                                                          |
| `npm run demo`                                                                                                                             | PASS; synthetic signature verified, local 204 and recorded ACK                       |
| `npm run pack:smoke`                                                                                                                       | PASS locally and in all six CI jobs                                                  |
| `npm pack --dry-run --json`, `npm pack --json`                                                                                             | PASS; actual tar entries and hashes independently inspected                          |
| `npm run pack:smoke -- --archive .cache/release/nottherealapi-cli-0.1.0.tgz`                                                               | PASS for the exact archive above; byte equality checked before installation          |
| `npm publish .cache/release/nottherealapi-cli-0.1.0.tgz --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org/` | PASS; warned that login is required for actual publish; no registry write            |
| `npm audit --audit-level=high --json`                                                                                                      | PASS; zero vulnerabilities at every severity                                         |
| Separate clean-clone build/pack                                                                                                            | PASS; identical integrity and file inventory                                         |
| Ordinary consumer `npm install` of the exact archive                                                                                       | PASS outside every source checkout; no injected lockfile or disabled install scripts |

The isolated locked consumer checks the installed bin's `--help`, `--version` and `auth`, both ESM export paths and TypeScript declaration resolution. The installed executable runs from the consumer directory with no source checkout dependencies. Both locked and ordinary consumers complete synthetic HTTPS/WSS ready/resync, byte/signature verification, one local 204 effect, recorded ACK and session close. Runtime dependencies in the ordinary consumer are recorded separately from the development lock; ranges can resolve newer versions for future consumers.

Sandboxed loopback attempts could not connect to their fixtures and were discarded/stopped. Accepted local network checks ran with loopback access; they contacted no hosted listener. CI independently passed the same fixtures across the supported matrix.

## GitHub CI

[Candidate run 39848206831](https://github.com/NotTheRealAPI/cli/actions/runs/39848206831), push event at the exact package-input commit above: **all six jobs succeeded**. Each job ran install, lint, format, the regression suite, schema-diff check, demo, packed consumer smoke and high-severity audit.

| OS      | Node 22.13.0                                                                           | Node 24                                                                                |
| ------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Windows | [PASS](https://github.com/NotTheRealAPI/cli/actions/runs/39848206831/job/120067059769) | [PASS](https://github.com/NotTheRealAPI/cli/actions/runs/39848206831/job/120067059807) |
| macOS   | [PASS](https://github.com/NotTheRealAPI/cli/actions/runs/39848206831/job/120067059673) | [PASS](https://github.com/NotTheRealAPI/cli/actions/runs/39848206831/job/120067060022) |
| Linux   | [PASS](https://github.com/NotTheRealAPI/cli/actions/runs/39848206831/job/120067060091) | [PASS](https://github.com/NotTheRealAPI/cli/actions/runs/39848206831/job/120067060163) |

CI retains `contents: read`, SHA-pinned actions and no publishing permissions or credentials. Only the synthetic local demo step was added. This report's later commit also triggers the same matrix; its result can be checked on the branch before merge. Revalidate the exact source commit selected for eventual publication.

## Security and scope findings

Reviewed the entire 39-file candidate tree, release-related history and 94 reachable Git blobs across the available refs, plus the real tarball's paths, entry types, contents and checksums. Pattern scans covered credential formats, private keys/certificates, infrastructure/database URLs, internal addresses, local filesystem paths, source maps and unexpected artefacts. Matches were reviewed without logging credential values. This is a release audit with heuristic scanning and code review, not proof that every possible secret format is detectable.

- No genuine committed credentials, private documents, customer data or private infrastructure endpoints were identified. Historical documentation contains a placeholder deployment example removed from current docs; it is not included in the archive. Test addresses, rejected SSRF inputs and privacy canaries are synthetic.
- The tracked synthetic loopback TLS key/certificate are intentional public test fixtures, described in `CONTRIBUTING.md`. Neither file nor any PEM material appears in the package. No source maps, source/tests/scripts, dependency directories, logs, cache files, archive-within-archive or unintended binaries appear in the package. Every tar entry is a regular file.
- Packed URL hostnames are limited to the public project origin, GitHub, JSON Schema and loopback examples. No hosted Preview promotion or private deployment origin is present. Protocol scope compatibility remains unchanged.
- Manifest bin, ESM exports, declarations, MIT notice, Node engine and public access agree with the installed archive. It has no install/preinstall/postinstall/prepare script; the prepack build is for maintainers only. Dependencies are installed separately by npm.
- The sole runtime-source edit is Production-focused help text. ACK/retry/fencing, byte fidelity, WebSocket lifecycle, safety probes, idle fallback and V1 schemas are unchanged. MIT and the existing copyright holder wording are retained.
- Work stayed in the public CLI repository. No private SaaS repository, hosted Preview/Production, deployment platform, database/cache service or customer credential was accessed.

## Historical checklist at the time of assessment

- [ ] Owner confirms the appropriate copyright name in `LICENSE` (currently `NotTheRealAPI`). No legal entity or personal name was invented. Trademark/name rights are separate from MIT code licensing.
- [ ] Maintainer confirms npm scope ownership, permission to create/publish `@nottherealapi/cli`, current name/version availability and the preferred account/2FA security method. The read-only local identity check returned `ENEEDAUTH`; package/scope checks were therefore not attempted. No registry auth was altered and no token was requested.
- [ ] Open/review a PR from the pushed branch. The GitHub connector's draft-PR request returned HTTP 403, `Resource not accessible by integration`; branch push and CI access succeeded. [Open the prepared comparison](https://github.com/NotTheRealAPI/cli/compare/main...npm-release-readiness?expand=1).
- [ ] Review this report and the [manual runbook](npm-release.md), approve the exact candidate, and confirm all checks on the eventual release commit.
- [ ] Separately authorise actual publication of the approved archive. Only then perform registry-integrity checks, clean registry consumer installation, and approved release tagging/GitHub release steps in the runbook.

The checklist above is retained as historical evidence; it is superseded by the owner decisions recorded at the top of this document. No automatic publishing or hosted enablement was introduced.
