# Manual npm release: @nottherealapi/cli 0.1.0

This is the manual procedure for the 0.1.0 release. The owner has authorised publication and, after registry verification, the matching `v0.1.0` tag and GitHub release. The owner confirmed npm organisation Owner access, enabled 2FA, and retention of `Copyright (c) 2026 NotTheRealAPI` under MIT. No further approval cycle is required for this release. Publishing the CLI does not enable hosted listeners; Production enablement remains a separate decision.

## Prepare from an exact commit

Use the public repository and the actual final release commit, including the final install instructions and dated changelog. Respect main-branch protection: use a release PR if required and record the actual merge commit before building the final archive. Do not infer that SHA from an earlier reviewed branch. If reproducing an existing release, resolve its tag to that SHA first. These commands use Bash (including Git Bash on Windows); replace `RELEASE_COMMIT_SHA` before running them.

```sh
git clone https://github.com/NotTheRealAPI/cli.git cli-release
cd cli-release
git checkout --detach RELEASE_COMMIT_SHA
git rev-parse HEAD
git status --porcelain
node --version
npm --version
```

Require an empty status and Node 22.13.0+ with npm 10+. Record the actual toolchain with the final archive; the historical readiness audit used Node 24.14.1 and npm 11.11.0. A build tool upgrade requires validation again. Keep Node type definitions on major 22. The maintained CI matrix is Windows/macOS/Linux × Node 22.13.0/24, with pinned actions, `contents: read` and no publishing credentials.

```sh
npm ci --ignore-scripts
npm run lint
npm run format:check
npm run build
npm test
git diff --exit-code -- docs/protocol-v1.schema.json
npm run demo
npm run pack:smoke
npm audit --audit-level=high
```

All delivery tests use synthetic loopback services. Never add hosted validation to this repository. Inspect the six successful GitHub Actions jobs for the actual release commit; success on the base commit is insufficient. Record the run URL and platform/Node results. If merging changes the commit, wait for the selected release commit's CI before publishing.

## Inspect and retain the archive

```sh
mkdir -p .cache/release-v0.1.0
npm pack --dry-run --json > .cache/release-v0.1.0/pack-dry-run.json
npm pack --json --pack-destination .cache/release-v0.1.0 > .cache/release-v0.1.0/pack.json
tar -tzf .cache/release-v0.1.0/nottherealapi-cli-0.1.0.tgz
npm run pack:smoke -- --archive .cache/release-v0.1.0/nottherealapi-cli-0.1.0.tgz
npm publish .cache/release-v0.1.0/nottherealapi-cli-0.1.0.tgz --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org/
git status --porcelain
```

The dry run writes no archive. Generate the final tarball once from the final commit and retain it unchanged. Review its actual inventory: compiled JS, sibling declarations, protocol/schema/example documents and public notices only. Reject keys/certificates, source maps, source/tests/scripts, caches, local paths, private deployment hosts, credentials or unexpected files. The synthetic test TLS key/certificate belong only in the public test tree. `pack:smoke -- --archive` copies the supplied tarball through npm, checks byte equality, and installs those exact bytes offline in a temporary consumer with the lockfile's runtime dependency graph. Normal install lifecycle behavior, the installed bin, auth, ESM imports, declaration resolution and local HTTPS/WSS delivery are checked. No source checkout is used by the installed CLI. The temporary consumer is deleted.

Record the full release SHA, archive `integrity` (SHA-512), `shasum` (SHA-1), byte size, file inventory, toolchain and CI results together in `.cache/release-v0.1.0/release.json`. The [historical audit](npm-release-readiness.md) documents earlier reproducibility evidence; its digest is not the final release digest. Keep the final archive unchanged through publishing; do not rebuild after acceptance. A dry run neither reserves a name/version nor proves publishing permission. Runtime dependency ranges are resolved by npm for consumers; the development lockfile is not shipped. Inspect the resolved runtime graph in a fresh ordinary consumer too.

## npm authentication

The owner decisions for this release are settled:

- Retain `Copyright (c) 2026 NotTheRealAPI` and MIT. Trademark/name rights are separate.
- The npm `nottherealapi` organisation exists and the owner has Owner access.
- npm two-factor authentication is enabled. Use the owner's trusted local login and complete any interactive 2FA challenge there. Follow the current [npm publishing security guidance](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/). Never put credentials or one-time codes in chat, Git, a command example or CI.

Check existing authentication without exposing credentials. If the automation environment returns `ENEEDAUTH` or cannot complete interactive authentication, hand off the verified archive and exact publish command. The owner can log in on their trusted terminal; do not request credentials in chat or redesign the workflow:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm org ls nottherealapi --json --registry=https://registry.npmjs.org/
npm view @nottherealapi/cli versions --json --registry=https://registry.npmjs.org/
```

Review account information privately. An npm 404 establishes neither scope rights nor successful publication; the owner's scope-access confirmation is recorded above. Do not create an organisation, grant access or alter 2FA settings as part of this release.

[Trusted publishing](https://docs.npmjs.com/trusted-publishers/) can use OIDC, but this release uses the existing manual workflow. Add no publisher grants, publish workflows, registry write secrets or npm tokens. Leave CI read-only.

## Publish and verify the exact archive

The owner has authorised this publication and its post-verification tag/GitHub release. Once validation and release-commit CI pass, publish the unchanged final archive. Do not add another approval gate.

From the validated checkout, using the unchanged tarball:

```sh
npm publish .cache/release-v0.1.0/nottherealapi-cli-0.1.0.tgz --ignore-scripts --access public --registry=https://registry.npmjs.org/
npm view @nottherealapi/cli@0.1.0 version dist.integrity dist.shasum dist.tarball --json --registry=https://registry.npmjs.org/
```

Complete npm's interactive authentication/2FA challenge locally. Do not claim publication until the registry returns version 0.1.0 and integrity/shasum match the retained `pack.json`. Investigate any mismatch before recommending installation. Download the registry artefact into a fresh directory and compare its inventory and integrity:

```sh
mkdir -p .cache/registry-check
npm pack @nottherealapi/cli@0.1.0 --ignore-scripts --json --pack-destination .cache/registry-check --registry=https://registry.npmjs.org/ > .cache/registry-check/pack.json
tar -tzf .cache/registry-check/nottherealapi-cli-0.1.0.tgz
```

Outside every source checkout, with no repository modules or global CLI masking the result, create a clean consumer:

```sh
mkdir cli-consumer
cd cli-consumer
npm init -y
npm install --save-exact @nottherealapi/cli@0.1.0 --registry=https://registry.npmjs.org/
npm ls --omit=dev
npm exec --offline -- nottherealapi --help
npm exec --offline -- nottherealapi --version
npm exec --offline -- nottherealapi auth
node --input-type=module -e 'import { VERSION } from "@nottherealapi/cli/protocol"; console.log(VERSION)'
```

Confirm version 0.1.0 and the Production availability notice. Re-run the local HTTPS/WSS archive smoke against the downloaded registry tarball from the validated clone. Do not connect to a hosted service as a publishing check.

After successful registry verification, tag the exact recorded release source commit and push that tag (never a moving HEAD):

```sh
git tag -a v0.1.0 RELEASE_COMMIT_SHA -m '@nottherealapi/cli 0.1.0'
git push origin refs/tags/v0.1.0
```

Create the GitHub release from that tag with concise changelog notes, the full source SHA, archive integrity and validation evidence. State that CLI publication does not enable Production hosted listeners. Do not create the tag or GitHub release before publication is independently verified.

## Failed publication or incident

If publish times out, query the exact version and integrity before retrying; it may have succeeded. Never assume the name/version can be reused. For wrong contents, stop promotion, privately report/revoke any exposed credentials with their issuer, assess the Git and registry exposure, then prepare a reviewed corrective version.

Prefer an owner-approved deprecation such as `npm deprecate @nottherealapi/cli@0.1.0 'Do not use this version; see the repository advisory.'` and a patched version. Deprecation is a registry write and needs its own approval. Adjust dist-tags only after a safe replacement exists. [npm's unpublish policy](https://docs.npmjs.com/policies/unpublish/) restricts removal, including time/dependency/download conditions; deletion is not a reliable rollback or credential remedy. A published name/version cannot be reused even if unpublished. Consult current npm policy/support before considering removal. Do not rewrite public history or delete a release as an automatic incident response.
