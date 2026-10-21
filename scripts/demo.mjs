import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  cloud,
  server,
  collect,
  event,
  TOKEN,
  SECRET,
} from "../test/fixture.mjs";
const item = event();
const receiver = await server(async (req, res) => {
  const bytes = await collect(req);
  const signature = req.headers["stripe-signature"] ?? "";
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature);
  const expected =
    match &&
    createHmac("sha256", SECRET).update(`${match[1]}.`).update(bytes).digest();
  if (!match || !timingSafeEqual(expected, Buffer.from(match[2], "hex"))) {
    res.writeHead(400);
    res.end();
    return;
  }
  res.writeHead(204);
  res.end();
});
const remote = await cloud({ events: [item] });
try {
  const child = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "listen",
      "--module",
      "stripe-payments",
      "--forward-to",
      `${receiver.url}/webhook`,
      "--api-url",
      remote.url,
      "--allow-loopback-api",
      "--once",
      "--json",
    ],
    { env: { ...process.env, NTAPI_LISTENER_TOKEN: TOKEN }, stdio: "inherit" },
  );
  process.exitCode = await new Promise((resolve) =>
    child.on("exit", (code) => resolve(code ?? 1)),
  );
  if (remote.acks.length !== 1 || remote.acks[0].outcome.status !== 204)
    process.exitCode = 1;
} finally {
  await remote.close();
  await receiver.close();
}
