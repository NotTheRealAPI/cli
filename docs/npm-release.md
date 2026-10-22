# Manual npm release: @nottherealapi/cli 0.1.0

Status: unreleased candidate. This runbook prepares an archive for review. It does not authorise publication, tags or a GitHub release. Publishing the CLI does not enable hosted listeners; Production enablement is a separate, privately approved decision.

## Prepare from an exact commit

Use a clean clone of the public repository and the full commit SHA approved by the owner. Do not publish from a moving branch. If reproducing an existing release, resolve its tag to that SHA first. These commands use Bash (including Git Bash on Windows); replace `APPROVED_FULL_COMMIT_SHA` before running them.

```sh
git clone https://github.com/NotTheRealAPI/cli.git cli-release
cd cli-release
git checkout --detach APPROVED_FULL_COMMIT_SHA
git rev-parse HEAD
git status --porcelain
node --version
npm --version
```

Require an empty status and Node 22.13.0+ with npm 10+. Use the exact Node/npm versions recorded in the readiness report to reproduce its archive. A build tool upgrade requires validation again. Keep Node type definitions on major 22. The maintained CI matrix is Windows/macOS/Linux × Node 22.13.0/24, with pinned actions, `contents: read` and no publishing credentials.

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

All delivery tests use synthetic loopback services. Never add hosted validation to this repository. Inspect the six successful GitHub Actions jobs for this exact candidate commit; success on the base commit is insufficient. Record each run URL and platform/Node result. If merging changes the commit or package inputs, validate the selected release commit again.

## Inspect and retain the archive

```sh
mkdir -p .cache/release
npm pack --dry-run --json > .cache/release/pack-dry-run.json
npm pack --json --pack-destination .cache/release > .cache/release/pack.json
tar -tzf .cache/release/nottherealapi-cli-0.1.0.tgz
npm run pack:smoke -- --archive .cache/release/nottherealapi-cli-0.1.0.tgz
npm publish .cache/release/nottherealapi-cli-0.1.0.tgz --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org/
git status --porcelain
```

The first two pack commands run the prepack build. Review the actual archive and dry-run inventory against the readiness report: compiled JS, sibling declarations, protocol/schema/example documents and public notices only. Reject keys/certificates, source maps, source/tests/scripts, caches, local paths, private deployment hosts, credentials or unexpected files. The synthetic test TLS key/certificate belong only in the public test tree. `pack:smoke -- --archive` copies the supplied tarball through npm, checks byte equality, and installs those exact bytes offline in a temporary consumer with the lockfile's runtime dependency graph. Normal install lifecycle behavior, the installed bin, auth, ESM imports, declaration resolution and local HTTPS/WSS delivery are checked. No source checkout is used by the installed CLI. The temporary consumer is deleted.

Record the archive `integrity` (SHA-512), `shasum` (SHA-1), byte size and file inventory from `pack.json`. Keep the archive unchanged through approval and publishing; do not rebuild between those steps. Repeat the pack from another clean checkout with the same toolchain and compare integrity for reproducibility. A dry run neither reserves a name/version nor proves publishing permission. Runtime dependency ranges are resolved by npm for consumers; the development lockfile is not shipped. Inspect the resolved runtime graph in a fresh ordinary consumer too.

## Owner prerequisites and npm access

Before approving a release:

- Confirm the legal copyright holder. `LICENSE` currently says `Copyright (c) 2026 NotTheRealAPI`; retain it until the owner decides whether that is appropriate. Keep MIT. Trademark/name rights are separate.
- Confirm control of the npm `@nottherealapi` scope and permission to create/publish `@nottherealapi/cli`. GitHub organisation access does not prove npm scope access. An npm 404 does not prove a name is available or that the scope is yours.
- Confirm the npm account's 2FA and organisation requirements. Prefer an interactive maintainer login and 2FA for this manual release. Follow the current [npm publishing security guidance](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/). Never put credentials or one-time codes in chat, Git, a command example or CI.

The maintainer may authenticate locally if needed; the candidate-preparation phase does not log in or change registry auth. On the maintainer's trusted terminal:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm org ls nottherealapi --json --registry=https://registry.npmjs.org/
npm view @nottherealapi/cli versions --json --registry=https://registry.npmjs.org/
```

Review the current identity's role in the organisation privately. For an existing package also check `npm access list packages YOUR_NPM_USERNAME --json` and `npm owner ls @nottherealapi/cli`. For an unpublished package, organisation policy and maintainer confirmation must establish permission to create it. Do not create an organisation, grant access or alter 2FA settings during candidate preparation. If access is unavailable, leave it as an explicit human prerequisite.

[Trusted publishing](https://docs.npmjs.com/trusted-publishers/) can use OIDC instead of stored CI credentials, but requires an independently approved trust configuration and workflow. This phase adds neither trusted publisher grants nor publish workflows, registry write secrets or npm tokens. It must leave existing CI read-only.

## Separate affirmative publish approval

Stop here until the owner explicitly approves both the candidate SHA/archive integrity and the actual npm publication. Resolve every blocker in the readiness report first. Approval to merge or prepare this candidate is not approval to publish.

Only after that separate go-ahead, from the validated clone and using the unchanged approved tarball:

```sh
npm publish .cache/release/nottherealapi-cli-0.1.0.tgz --ignore-scripts --access public --registry=https://registry.npmjs.org/
npm view @nottherealapi/cli@0.1.0 version dist.integrity dist.shasum dist.tarball --json --registry=https://registry.npmjs.org/
```

Complete npm's interactive authentication/2FA challenge locally. Compare registry integrity/shasum to the approved `pack.json`. Investigate any mismatch before recommending installation. Download the registry artefact into a fresh directory and compare its inventory and integrity:

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

After successful registry verification and separate approval for release metadata, tag the approved source commit and push that tag (never a moving HEAD):

```sh
git tag -a v0.1.0 APPROVED_FULL_COMMIT_SHA -m '@nottherealapi/cli 0.1.0'
git push origin refs/tags/v0.1.0
```

Create the GitHub release manually from that tag with the changelog, archive integrity and validation evidence. State that CLI publication does not enable Production hosted listeners. No tag, release or publication is created during readiness work.

## Failed publication or incident

If publish times out, query the exact version and integrity before retrying; it may have succeeded. Never assume the name/version can be reused. For wrong contents, stop promotion, privately report/revoke any exposed credentials with their issuer, assess the Git and registry exposure, then prepare a reviewed corrective version.

Prefer an owner-approved deprecation such as `npm deprecate @nottherealapi/cli@0.1.0 'Do not use this version; see the repository advisory.'` and a patched version. Deprecation is a registry write and needs its own approval. Adjust dist-tags only after a safe replacement exists. [npm's unpublish policy](https://docs.npmjs.com/policies/unpublish/) restricts removal, including time/dependency/download conditions; deletion is not a reliable rollback or credential remedy. A published name/version cannot be reused even if unpublished. Consult current npm policy/support before considering removal. Do not rewrite public history or delete a release as an automatic incident response.
