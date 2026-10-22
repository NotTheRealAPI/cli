import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { cloud, collect, event, server, TOKEN, SECRET } from "./fixture.mjs";
import { NOTIFY_VERSION as version } from "../dist/notifications.js";

export async function notifyingCloud(options = {}) {
  const remote = await cloud(options);
  const [httpHandler] = remote.instance.listeners("request");
  remote.instance.removeAllListeners("request");
  const tickets = [],
    envelopes = [],
    sockets = [],
    upgrades = [];
  const minted = new Set();
  const upgradeSockets = new Set();
  remote.instance.on("request", async (req, res) => {
    if (req.url !== "/listener/notify/v1/tickets") return httpHandler(req, res);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(req.headers["x-ntapi-listener-notify-version"], version);
    const body = JSON.parse((await collect(req)).toString());
    assert.deepEqual(Object.keys(body).sort(), ["sessionId", "version"]);
    assert.equal(body.version, version);
    assert.ok(remote.calls.some((x) => x.route === "register"));
    tickets.push(body);
    if (options.onTicket?.(req, res, body, tickets.length)) return;
    const ticket = `ntapi_nt_${randomBytes(32).toString("base64url")}`;
    minted.add(ticket);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        options.ticketEnvelope?.({
          version,
          ticket,
          expiresAt: new Date(
            (options.now?.() ?? Date.now()) + 25_000,
          ).toISOString(),
        }) ?? {
          version,
          ticket,
          expiresAt: new Date(
            (options.now?.() ?? Date.now()) + 25_000,
          ).toISOString(),
        },
      ),
    );
  });
  const wss = new WebSocketServer({ noServer: true });
  remote.instance.on("upgrade", (req, socket, head) => {
    upgradeSockets.add(socket);
    socket.once("close", () => upgradeSockets.delete(socket));
    upgrades.push(req);
    assert.equal(req.url, "/listener/notify/v1/socket");
    for (const name of ["authorization", "cookie", "sec-websocket-protocol"])
      assert.equal(req.headers[name], undefined);
    if (options.onUpgrade?.(req, socket, head)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("error", () => {});
      ws.on("message", (raw, binary) => {
        assert.equal(binary, false);
        const envelope = JSON.parse(raw.toString());
        assert.deepEqual(Object.keys(envelope).sort(), ["ticket", "version"]);
        assert.equal(envelope.version, version);
        assert.ok(
          minted.delete(envelope.ticket),
          "ticket must be fresh and redeemed only once",
        );
        envelopes.push(envelope);
        if (options.onSubscribe) options.onSubscribe(ws, envelopes.length);
        else ws.send(JSON.stringify({ version, event: "ready" }));
      });
    });
  });
  let secure;
  let url = remote.url;
  if (options.tls) {
    // Public synthetic test key/certificate, trusted only by the smoke subprocess.
    secure = https.createServer(
      {
        key: await readFile(
          new URL("./fixtures/localhost-key.pem", import.meta.url),
        ),
        cert: await readFile(
          new URL("./fixtures/localhost-cert.pem", import.meta.url),
        ),
      },
      (req, res) => remote.instance.emit("request", req, res),
    );
    secure.on("upgrade", (req, socket, head) =>
      remote.instance.emit("upgrade", req, socket, head),
    );
    await new Promise((resolve) => secure.listen(0, "127.0.0.1", resolve));
    url = `https://127.0.0.1:${secure.address().port}`;
  }
  return {
    ...remote,
    url,
    tickets,
    envelopes,
    sockets,
    upgrades,
    hint(event = "resync") {
      for (const ws of sockets)
        if (ws.readyState === 1) ws.send(JSON.stringify({ version, event }));
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      for (const socket of upgradeSockets) socket.destroy();
      await new Promise((resolve) => wss.close(resolve));
      if (secure)
        await new Promise((resolve) => {
          secure.close(resolve);
          secure.closeAllConnections();
        });
      await remote.close();
    },
  };
}

export async function notificationSmoke(bin) {
  const raw = Buffer.from(' {"id":"evt_notify_smoke","text":"é🌍"}\r\n\t');
  const item = event(raw);
  let effects = 0;
  const local = await server(async (req, res) => {
    const body = await collect(req);
    assert.deepEqual(body, raw);
    const [timestamp, signature] = req.headers["stripe-signature"].split(",");
    assert.equal(
      createHmac("sha256", SECRET)
        .update(timestamp.slice(2) + ".")
        .update(body)
        .digest("hex"),
      signature.slice(3),
    );
    effects++;
    res.writeHead(204);
    res.end();
  });
  let hintTimer;
  const remote = await notifyingCloud({
    tls: true,
    events: [],
    onSubscribe: (ws) => {
      ws.send(JSON.stringify({ version, event: "ready" }));
      hintTimer = setTimeout(() => {
        remote.queue.push(item);
        remote.hint();
      }, 50);
    },
  });
  try {
    const child = spawn(
      process.execPath,
      [
        bin,
        "listen",
        "--module",
        "stripe-payments",
        "--forward-to",
        local.url,
        "--api-url",
        remote.url,
        "--once",
        "--max-idle-polls",
        "0",
        "--json",
      ],
      {
        env: {
          ...process.env,
          NTAPI_LISTENER_TOKEN: TOKEN,
          NODE_EXTRA_CA_CERTS: fileURLToPath(
            new URL("./fixtures/localhost-cert.pem", import.meta.url),
          ),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (errors += x));
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      assert.equal(code, 0, errors || output);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(effects, 1);
    assert.equal(remote.acks.length, 1);
    assert.equal(remote.acks[0].outcome.status, 204);
    assert.equal(remote.calls.at(-1).route, "close");
    assert.match(output, /notifications_ready/);
    assert.match(output, /acknowledged/);
    assert.doesNotMatch(
      output + errors,
      /ntapi_nt_|ntapi_lst_|localhost-key|stripe-signature/,
    );
    return "HTTPS/WSS ready + resync, exact bytes/signature, local 204, recorded ACK and session close";
  } finally {
    clearTimeout(hintTimer);
    await remote.close();
    await local.close();
  }
}
