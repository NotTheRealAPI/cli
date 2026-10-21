import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  await writeManifest();
  npm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(directory, listing.filename),
    ],
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
async function writeManifest() {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "pack-consumer", private: true }),
  );
}
