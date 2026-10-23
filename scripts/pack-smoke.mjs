import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { notificationSmoke } from "../test/notify-fixture.mjs";
import { providerContract } from "../test/provider-contract.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run via npm run pack:smoke");
const root = process.cwd();
const { values } = parseArgs({ options: { archive: { type: "string" } } });
const archive = values.archive && path.resolve(values.archive);
const directory = await mkdtemp(path.join(tmpdir(), "ntapi-pack-"));
function npm(args, cwd = root) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
try {
  const listing = JSON.parse(
    npm([
      "pack",
      ...(archive ? [archive] : []),
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ]),
  )[0];
  if (archive)
    assert.deepEqual(
      await readFile(path.join(directory, listing.filename)),
      await readFile(archive),
      "The consumer must install the exact supplied archive bytes",
    );
  assert.ok(listing.files.some((x) => x.path === "dist/cli.js"));
  assert.ok(!listing.files.some((x) => /\.(?:pem|key|pfx|p12)$/i.test(x.path)));
  assert.ok(
    !listing.files.some((x) =>
      /^(src|test|scripts|node_modules|\.github)\//.test(x.path),
    ),
  );
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const publicFiles = new Set([
    "package.json",
    ...pkg.files.filter((name) => !name.includes("*")),
    ...(await readdir(path.join(root, "src")))
      .filter((name) => name.endsWith(".ts"))
      .flatMap((name) => [
        `dist/${name.replace(/\.ts$/, ".js")}`,
        `dist/${name.replace(/\.ts$/, ".d.ts")}`,
      ]),
  ]);
  assert.deepEqual(
    listing.files.map((entry) => entry.path).sort(),
    [...publicFiles].sort(),
    "Archive must contain exactly the public files and current compiled modules",
  );
  await writeManifest(listing);
  npm(["ci", "--offline", "--no-audit", "--no-fund"], directory);
  const metadata = JSON.parse(
    await readFile(
      path.join(directory, "node_modules/@nottherealapi/cli/package.json"),
      "utf8",
    ),
  );
  assert.equal(metadata.bin.nottherealapi, "dist/cli.js");
  assert.equal(metadata.name, "@nottherealapi/cli");
  assert.equal(metadata.version, "0.2.0");
  assert.equal(metadata.type, "module");
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.engines.node, ">=22.13.0");
  assert.equal(metadata.publishConfig.access, "public");
  for (const name of ["preinstall", "install", "postinstall", "prepare"])
    assert.equal(metadata.scripts?.[name], undefined);
  const installed = path.join(directory, "node_modules/@nottherealapi/cli");
  for (const entry of listing.files) {
    const content = await readFile(path.join(installed, entry.path), "utf8");
    assert.doesNotMatch(
      content,
      /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
    );
    assert.doesNotMatch(content, /sourceMappingURL=/);
    if (entry.path.endsWith(".js"))
      assert.ok(
        listing.files.some(
          (x) => x.path === entry.path.replace(/\.js$/, ".d.ts"),
        ),
        `Missing declaration: ${entry.path}`,
      );
  }
  const imports = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict"; import { listen, ProtocolClient, v2 } from "@nottherealapi/cli"; import { VERSION, claimSchema } from "@nottherealapi/cli/protocol"; import * as contract from "@nottherealapi/cli/protocol-v2"; assert.equal(typeof listen, "function"); assert.equal(typeof ProtocolClient, "function"); assert.equal(VERSION, "ntapi.listener.v1"); assert.equal(typeof claimSchema.parse, "function"); assert.equal(v2.VERSION, "ntapi.listener.v2"); assert.equal(contract.claimSchema, v2.claimSchema);',
    ],
    { cwd: directory, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(imports.status, 0, imports.stderr || imports.stdout);
  await writeFile(
    path.join(directory, "consumer.mts"),
    'import { listen, ProtocolClient, type Scope, type DeliveryClaim } from "@nottherealapi/cli"; import { VERSION } from "@nottherealapi/cli/protocol"; import { type Claim, claimSchema } from "@nottherealapi/cli/protocol-v2"; const scope: Scope = { module: "synthetic", environment: "production", destination: "0".repeat(64) }; const claim: Claim = claimSchema.parse({}); const delivery: DeliveryClaim = claim; const client = new ProtocolClient(new URL("https://example.test"), "synthetic", 100, "v2"); void [listen, VERSION, scope, delivery, client];',
  );
  const types = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--typeRoots",
      path.join(root, "node_modules/@types"),
      "consumer.mts",
    ],
    { cwd: directory, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(types.status, 0, types.stderr || types.stdout);
  assert.match(
    npm(["exec", "--offline", "--", "nottherealapi", "--version"], directory),
    /^0\.2\.0\s*$/,
  );
  assert.match(
    npm(["exec", "--offline", "--", "nottherealapi", "--help"], directory),
    /default production; does not select API host/,
  );
  assert.match(
    npm(["exec", "--offline", "--", "nottherealapi", "auth"], directory),
    /Production listeners are not currently enabled/,
  );
  console.log(
    await notificationSmoke(
      path.join(directory, "node_modules/@nottherealapi/cli/dist/cli.js"),
      directory,
    ),
  );
  console.log(
    await providerContract(path.join(installed, "dist/cli.js"), directory),
  );
  console.log(
    `Packed bin installed and executed: ${listing.files.length} files, ${listing.size} bytes (${process.platform}, ${process.version})`,
  );
} finally {
  await cleanup(directory);
}
async function cleanup(directory) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("ntapi-pack-")
  )
    throw new Error("Unexpected cleanup target");
  await rm(resolved, { recursive: true, force: true });
}
async function writeManifest(listing) {
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const sourceLock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const archive = pathToFileURL(path.join(directory, listing.filename)).href;
  const manifest = {
    name: "pack-consumer",
    version: "1.0.0",
    private: true,
    dependencies: { [pkg.name]: archive },
  };
  // npm ci caches tarballs, not registry packuments. Carry the locked runtime graph
  // into the isolated consumer so offline installation needs no hidden metadata cache.
  const packages = Object.fromEntries(
    Object.entries(sourceLock.packages).filter(
      ([name, pkg]) => name && !pkg.dev,
    ),
  );
  packages[""] = manifest;
  packages[`node_modules/${pkg.name}`] = {
    version: pkg.version,
    resolved: archive,
    integrity: listing.integrity,
    dependencies: pkg.dependencies,
    bin: pkg.bin,
    engines: pkg.engines,
    license: pkg.license,
  };
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    path.join(directory, "package-lock.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    }),
  );
}
