# Package validation and manual releases

This is public maintainer guidance for `@nottherealapi/cli`. Version **0.2.0 is an unpublished candidate**. Validation does not authorize merging, tagging, creating a GitHub release or publishing to npm. Those actions require a separate owner decision for the exact candidate. Package publication does not establish hosted listener availability.

## Validate the source

Use a clean checkout at the exact proposed release commit. Record its full SHA, Node/npm versions and operating system. Require Node 22.13.0+ and npm 10+; CI covers Linux, macOS and Windows on Node 22.13.0 and 24. Keep the Node type definitions on major 22.

```sh
npm ci
npm run lint
npm run format:check
npm run build
npm test
npm run test:v2-durability
npm run test:provider-agnostic-contract
git diff --exit-code -- docs/protocol-v1.schema.json docs/protocol-v2.schema.json
npm run demo
npm audit --omit=dev
npm run pack:smoke
```

Tests use synthetic loopback services; no hosted service or credentials are required. Confirm all six CI jobs pass at the proposed commit. CI uses read-only repository permissions and carries no publishing credentials. A different merge/release commit requires fresh validation.

## Inspect the exact archive

These commands use Bash (including Git Bash on Windows). Keep generated evidence under ignored `.cache/`; substitute the candidate version when preparing a later release.

```sh
mkdir -p .cache/package-candidate
npm pack --dry-run --json > .cache/package-candidate/pack-dry-run.json
npm pack --json --pack-destination .cache/package-candidate > .cache/package-candidate/pack.json
tar -tzf .cache/package-candidate/nottherealapi-cli-0.2.0.tgz
npm run pack:smoke -- --archive .cache/package-candidate/nottherealapi-cli-0.2.0.tgz
```

The dry run does not create an archive. Review the actual tar entries and contents, including generated JS/types and Markdown. Expected contents are current compiled modules and declarations, both versioned contracts/schemas/synthetic examples, notification/security documentation and public project notices. Exclude test SDKs, source/tests/scripts, private operational material, credentials, TLS fixtures, source maps, caches, logs and local filesystem paths. Relative Markdown links must resolve inside the archive; repository-only resources need intentional public absolute links.

Record archive SHA-256, npm integrity/shasum, size, full file inventory and CI results outside the tracked public tree. PowerShell can calculate SHA-256 with `Get-FileHash -Algorithm SHA256`; use `sha256sum` on Linux or `shasum -a 256` on macOS. Preserve the exact archive through acceptance and any later approved publication.

`pack:smoke -- --archive` checks byte equality before installing the supplied archive offline in an isolated consumer using the locked runtime graph. It verifies executable/help/auth, root ESM exports, frozen `/protocol`, `/protocol-v2`, TypeScript declarations, explicit V1 HTTPS/WSS and provider-neutral V2 delivery with independent test SDKs. Run it on both supported Node versions. Also inspect a fresh ordinary installation with normal lifecycle behavior and runtime range resolution; the development lockfile is not shipped.

## Owner-controlled publication

Before a separately approved release, confirm the candidate version, changelog, install instructions, licence, npm scope rights and current registry version availability. Do not put credentials or one-time codes in chat, Git, examples or CI. Follow npm's current [publishing security guidance](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/) using a trusted local login or a separately configured [trusted publisher](https://docs.npmjs.com/trusted-publishers/).

After authorized publication of the retained archive, independently compare registry version, integrity and inventory with the accepted candidate and test a fresh registry installation. Only then create an owner-authorized matching tag/release at the recorded source commit. Keep release notes clear about hosted availability. Do not infer authorization from a previous version's release.

If publication times out, inspect the exact registry version and integrity before retrying. For wrong contents, stop promotion, revoke any exposed credentials with their issuer and prepare a reviewed corrective version. Removing a file or squashing commits does not remove previously exposed history. Deprecation, dist-tag changes and removal are registry writes requiring deliberate owner decisions; consult [npm's unpublish policy](https://docs.npmjs.com/policies/unpublish/) before considering removal.
