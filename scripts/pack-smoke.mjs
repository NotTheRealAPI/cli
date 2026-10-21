import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run via npm run pack:smoke");
const root = process.cwd();
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
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ]),
  )[0];
  assert.ok(listing.files.some((x) => x.path === "dist/cli.js"));
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
  ]);
  for (const entry of listing.files) {
    assert.ok(
      publicFiles.has(entry.path) ||
        /^dist\/[a-z]+\.(?:js|d\.ts)$/.test(entry.path),
      `Unexpected package file: ${entry.path}`,
    );
  }
  await writeManifest(listing);
  npm(
    ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
  );
  const metadata = JSON.parse(
    await readFile(
      path.join(directory, "node_modules/@nottherealapi/cli/package.json"),
      "utf8",
    ),
  );
  assert.equal(metadata.bin.nottherealapi, "dist/cli.js");
  assert.match(
    npm(["exec", "--offline", "--", "nottherealapi", "--version"], directory),
    /^0\.1\.0\s*$/,
  );
  assert.match(
    npm(["exec", "--offline", "--", "nottherealapi", "--help"], directory),
    /hosted support pending/,
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
