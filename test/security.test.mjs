import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  writeFile,
  chmod,
  symlink,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loopbackUrl, configuration, delayFor } from "../dist/index.js";
import { retryAfter } from "../dist/client.js";
import { forward } from "../dist/transport.js";
import * as p from "../dist/protocol.js";
import { event, TOKEN } from "./fixture.mjs";

for (const url of [
  "https://example.com/x",
  "http://192.168.0.1",
  "http://169.254.169.254/metadata",
  "http://127.0.0.2",
  "http://0.0.0.0",
  "http://localhost.evil.test",
  "http://localhost@evil.test",
  "http://user:pass@localhost",
  "file:///tmp/a",
  "ftp://localhost",
  "http://2130706433",
  "http://0177.0.0.1",
  "http://127.1",
  "http://[::ffff:127.0.0.1]",
  "http://localhost/#secret",
  "http://localhost\\@evil.test",
])
  test(`reject target ${url}`, () => assert.throws(() => loopbackUrl(url)));
for (const url of [
  "http://localhost:3000/a?q=1",
  "https://127.0.0.1/x",
  "http://[::1]:3000/",
])
  test(`accept numerical pinned target ${url}`, () => {
    const parsed = loopbackUrl(url);
    assert.ok(["127.0.0.1", "[::1]"].includes(parsed.hostname));
  });
const args = [
  "listen",
  "--module",
  "stripe-payments",
  "--forward-to",
  "http://localhost:3000/webhook",
];
test("scope digest canonicalizes localhost without exposing route", async () => {
  const cfg = await configuration(args, { NTAPI_LISTENER_TOKEN: TOKEN });
  assert.equal(
    cfg.scope.destination,
    p.sha256("http://127.0.0.1:3000/webhook"),
  );
});
for (const [caseIndex, options] of [
  ["--api-url", "http://example.com"],
  ["--api-url", "http://169.254.169.254", "--allow-loopback-api"],
  ["--api-url", "https://u:p@example.com"],
  ["--api-url", "https://example.com/private"],
  ["--environment", "test"],
  ["--insecure"],
  ["--local-timeout-ms", "Infinity"],
  ["--request-timeout-ms", "0"],
  ["--poll-wait-ms", "10001"],
  ["--backoff-ms", "999999"],
  ["--token", TOKEN, "--token-file", "file"],
].entries())
  test(`reject invalid options ${options[0]} (case ${caseIndex + 1})`, async () => {
    await assert.rejects(
      configuration([...args, ...options], { NTAPI_LISTENER_TOKEN: TOKEN }),
    );
  });
test("no account keys and no TLS bypass", async () => {
  await assert.rejects(
    configuration(args, { NTAPI_LISTENER_TOKEN: "sk_live_account_wide" }),
    /scoped_listener_token/,
  );
  await assert.rejects(
    configuration(args, {
      NTAPI_LISTENER_TOKEN: TOKEN,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    }),
    /tls_bypass/,
  );
});
test("token-file security matches documented platform policy", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ntapi-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  if (process.platform === "win32") {
    await assert.rejects(
      configuration([...args, "--token-file", tokenFile], {}),
      /use_environment/,
    );
    return;
  }
  const config = await configuration([...args, "--token-file", tokenFile], {});
  assert.equal(config.token, TOKEN);
  await chmod(tokenFile, 0o644);
  await assert.rejects(
    configuration([...args, "--token-file", tokenFile], {}),
    /protected_token/,
  );
  await chmod(tokenFile, 0o600);
  const link = path.join(directory, "link");
  await symlink(tokenFile, link);
  await assert.rejects(
    configuration([...args, "--token-file", link], {}),
    /protected_token/,
  );
});
test("connect deadline via injected unconnected socket; no transmitted bytes or false success", async () => {
  const fake = () => {
    const req = new EventEmitter();
    req.socket = { bytesWritten: 0 };
    req.end = () => {
      req.emit("socket", new EventEmitter());
    };
    req.destroy = () => {
      req.emit("error", new Error("simulated"));
    };
    return req;
  };
  const outcome = await forward(
    new URL("http://127.0.0.1"),
    { body: Buffer.from("x"), headers: {} },
    50,
    new AbortController().signal,
    fake,
  );
  assert.equal(outcome.classification, "connection_error");
  assert.equal(outcome.error, "timeout");
  assert.equal(outcome.requestBytes, 0);
});
test("backoff clock: exponential cap, jitter, Retry-After seconds/date/budget", () => {
  const config = { backoffMs: 500, backoffCapMs: 30_000 };
  assert.equal(delayFor(0, config, 0), 250);
  assert.equal(delayFor(0, config, 1), 500);
  assert.equal(delayFor(1, config, 1), 1000);
  assert.equal(delayFor(100, config, 1), 30_000);
  assert.equal(delayFor(1, config, 0, 4000), 4000);
  assert.equal(retryAfter("2"), 2000);
  assert.equal(retryAfter(new Date(5000).toUTCString(), 1000), 4000);
  assert.equal(retryAfter("invalid"), 0);
  assert.throws(() => retryAfter("61"), /retry_after_exceeds/);
});
test("schemas and shipped contract examples are executable", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../docs/fixtures/v1.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [name, value] of Object.entries(fixture)) p[name].parse(value);
  const schema = JSON.parse(
    await readFile(
      new URL("../docs/protocol-v1.schema.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    Object.keys(schema.$defs).sort(),
    Object.keys(p)
      .filter((x) => x.endsWith("Schema"))
      .sort(),
  );
  assert.equal(
    p.decodePayload(p.claimSchema.parse(fixture.claimSchema)).body.toString(),
    "{}",
  );
});
test("all header casing preserves signature value and provider ID", () => {
  const claim = event();
  claim.headers.push(["STRIPE-ACCOUNT", "acct_synthetic"]);
  const decoded = p.decodePayload(p.claimSchema.parse(claim));
  assert.equal(decoded.headers["stripe-signature"], claim.headers[1][1]);
  assert.equal(decoded.headers["stripe-account"], "acct_synthetic");
});
for (const arg of ["--help", "--version", "auth"])
  test(`executable ${arg}`, () => {
    const result = spawnSync(process.execPath, ["dist/cli.js", arg], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length > 0);
    assert.equal(result.stderr, "");
  });
test("argument and authentication errors never echo secrets in stderr/JSON", () => {
  for (const extra of [
    ["--bad-secret=CANARY_PRIVATE"],
    ["--token", "PRIVATE_BAD_TOKEN"],
    ["--forward-to", "https://secret:PRIVATE@bad.test/SECRET_PATH"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["dist/cli.js", ...args, "--json", ...extra],
      {
        encoding: "utf8",
        env: { ...process.env, NTAPI_LISTENER_TOKEN: TOKEN },
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal((result.stdout + result.stderr).includes("PRIVATE"), false);
    JSON.parse(result.stderr);
  }
});
