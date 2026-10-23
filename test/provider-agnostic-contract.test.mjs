import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { providerContract } from "./provider-contract.mjs";

test("provider-agnostic-contract: unknown names, changing headers, media types, real sockets and ACK", async () => {
  await providerContract("dist/cli.js");
  const production = (
    await Promise.all(
      (await readdir(new URL("../src/", import.meta.url)))
        .filter((x) => x.endsWith(".ts"))
        .map((x) => readFile(new URL(`../src/${x}`, import.meta.url), "utf8")),
    )
  ).join("\n");
  for (const name of [
    "X-Future-Signature",
    "X-Future-Timestamp",
    "X-Future-Correlation",
    "X-Orbit-Proof",
    "X-Orbit-Time",
    "X-Orbit-Trace",
  ])
    assert.equal(production.toLowerCase().includes(name.toLowerCase()), false);
});
