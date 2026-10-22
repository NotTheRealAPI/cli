import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { configuration, listen, reporter } from "../dist/index.js";
import {
  Notifications,
  Wakeup,
  NOTIFY_VERSION as version,
} from "../dist/notifications.js";
import { timing } from "../dist/listener.js";
import { server, collect, event, TOKEN } from "./fixture.mjs";
import { notifyingCloud, notificationSmoke } from "./notify-fixture.mjs";

async function setup(t, options = {}, handler = (_req, res) => res.end()) {
  const local = await server(handler);
  const remote = await notifyingCloud(options);
  t.after(async () => {
    await remote.close();
    await local.close();
  });
  const config = await configuration(
    [
      "listen",
      "--module",
      "stripe-payments",
      "--forward-to",
      local.url,
      "--api-url",
      remote.url,
      "--allow-loopback-api",
      "--request-timeout-ms",
      "500",
      "--local-timeout-ms",
      "300",
      "--poll-wait-ms",
      "0",
      "--once",
    ],
    { NTAPI_LISTENER_TOKEN: TOKEN },
  );
  const lines = [];
  const report = reporter(true, (line) => lines.push(JSON.parse(line)));
  return {
    remote,
    local,
    config,
    lines,
    report,
    run: (signal = new AbortController().signal, clock = timing) =>
      listen(config, report, signal, clock),
  };
}

test("subscribe -> ready -> initial probe recovers preexisting bytes; hints cannot duplicate work", async (t) => {
  const raw = Buffer.from(' {"x":"🌍"}\r\n');
  const item = event(raw);
  let effects = 0;
  const f = await setup(t, { events: [item] }, async (req, res) => {
    effects++;
    assert.deepEqual(await collect(req), raw);
    assert.equal(req.headers["stripe-signature"], item.headers[1][1]);
    assert.equal(f.remote.envelopes.length, 1);
    f.remote.hint();
    f.remote.hint();
    res.writeHead(204);
    res.end();
  });
  assert.equal(await f.run(), 0);
  assert.equal(effects, 1);
  assert.equal(f.remote.acks.length, 1);
  assert.ok(
    f.lines.findIndex((x) => x.state === "notifications_ready") <
      f.lines.findIndex((x) => x.state === "claimed"),
  );
  assert.equal(
    JSON.stringify(f.lines).includes(f.remote.envelopes[0].ticket),
    false,
  );
});

test("resync during local work and lost ACK drains sequentially without another execution", async (t) => {
  let effects = 0,
    active = 0;
  const f = await setup(
    t,
    { events: [event(), event()], faults: { ack: ["lost_receipt"] } },
    async (_req, res) => {
      assert.equal(++active, 1);
      effects++;
      for (let i = 0; i < 20; i++) f.remote.hint();
      await sleep(20);
      active--;
      res.end();
    },
  );
  f.config.once = false;
  f.config.maxIdlePolls = 1;
  assert.equal(await f.run(), 4);
  assert.equal(effects, 2);
  assert.equal(f.remote.acks.length, 2);
});

test("healthy missing hints uses 60-second safety probes, renews without changing session, and stops at idle limit", async (t) => {
  let now = Date.now();
  const waits = [];
  const f = await setup(t, { events: [], now: () => now });
  f.config.once = false;
  f.config.maxIdlePolls = 7;
  assert.equal(
    await f.run(undefined, {
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    }),
    4,
  );
  assert.ok(waits.filter((ms) => ms === 60_000).length >= 4);
  assert.equal(
    waits.some((ms) => ms === 5000),
    false,
  );
  assert.equal(f.remote.calls.filter((x) => x.route === "register").length, 2);
  assert.ok(
    f.remote.tickets.every(
      (x) => x.sessionId === f.remote.tickets[0].sessionId,
    ),
  );
});

test("--once idle is bounded; explicit zero waits for a later resync", async (t) => {
  const f = await setup(t, { events: [] });
  assert.equal(await f.run(), 4);
  f.config.maxIdlePolls = 0;
  const stop = new AbortController();
  t.after(() => stop.abort());
  const run = f.run(stop.signal);
  await sleep(50);
  f.remote.queue.push(event());
  f.remote.hint();
  assert.equal(await run, 0);
});

for (const [name, send] of [
  ["binary", (ws) => ws.send(Buffer.from("secret raw frame"))],
  ["oversize", (ws) => ws.send("x".repeat(1025))],
  ["invalid JSON", (ws) => ws.send("secret raw frame")],
  [
    "wrong version",
    (ws) => ws.send(JSON.stringify({ version: "bad", event: "ready" })),
  ],
  [
    "extra key",
    (ws) =>
      ws.send(JSON.stringify({ version, event: "ready", secret: "PRIVATE" })),
  ],
  [
    "resync before ready",
    (ws) => ws.send(JSON.stringify({ version, event: "resync" })),
  ],
  ["invalid UTF8", (ws) => ws.send(Buffer.from([255]), { binary: false })],
  [
    "unknown event",
    (ws) => ws.send(JSON.stringify({ version, event: "PRIVATE" })),
  ],
])
  test(`${name} denied safely; HTTPS fallback still delivers`, async (t) => {
    const f = await setup(t, { onSubscribe: send });
    assert.equal(await f.run(), 0);
    assert.equal(
      f.lines.some((x) => x.state === "notifications_ready"),
      false,
    );
    assert.equal(
      f.lines.some((x) => x.state === "notifications_fallback"),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(f.lines),
      /PRIVATE|secret raw frame|ntapi_nt_/,
    );
  });

test("executable HTTPS/WSS smoke with trusted loopback certificate", async () => {
  await notificationSmoke("dist/cli.js");
});

for (const [name, mutate] of [
  ["wrong ticket version", (x) => ({ ...x, version: "bad" })],
  ["extra ticket key", (x) => ({ ...x, extra: true })],
  ["bad ticket format", (x) => ({ ...x, ticket: "PRIVATE" })],
  ["expired ticket", (x) => ({ ...x, expiresAt: new Date(0).toISOString() })],
  [
    "excess ticket TTL",
    (x) => ({ ...x, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  ],
])
  test(`${name} never reaches socket`, async (t) => {
    const f = await setup(t, { ticketEnvelope: mutate });
    assert.equal(await f.run(), 0);
    assert.equal(f.remote.upgrades.length, 0);
  });

for (const status of [404, 503])
  test(`notification HTTP ${status} falls back with bounded retries`, async (t) => {
    let now = Date.now();
    const f = await setup(t, {
      events: [],
      now: () => now,
      onTicket: (_req, res) => {
        res.writeHead(status);
        res.end("PRIVATE");
        return true;
      },
    });
    f.config.maxIdlePolls = 6;
    assert.equal(
      await f.run(undefined, {
        now: () => now,
        random: () => 0,
        sleep: async (ms) => {
          now += ms;
        },
      }),
      4,
    );
    assert.ok(f.remote.tickets.length <= 2);
    assert.equal(f.remote.calls.filter((x) => x.route === "poll").length, 6);
  });

for (const status of [401, 403])
  test(`notification auth ${status} is terminal and sanitized`, async (t) => {
    const f = await setup(t, {
      onTicket: (_req, res) => {
        res.writeHead(status);
        res.end("PRIVATE");
        return true;
      },
    });
    await assert.rejects(
      f.run(),
      (e) => e.exitCode === 3 && !e.stack.includes("PRIVATE"),
    );
    assert.equal(f.remote.calls.filter((x) => x.route === "poll").length, 0);
  });

test("closing and disconnection reconnect with fresh tickets and preserve durable identity", async (t) => {
  let now = Date.now();
  const f = await setup(t, { events: [], now: () => now });
  const stop = new AbortController();
  const wake = new Wakeup();
  const clock = { ...timing, now: () => now, random: () => 0 };
  const n = new Notifications(
    new URL(f.remote.url),
    TOKEN,
    500,
    wake,
    f.report,
    clock,
  );
  t.after(() => {
    n.stop();
    stop.abort();
  });
  const session = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    expiresAt: new Date(now + 300_000).toISOString(),
  };
  // Register first using the authoritative client.
  const { ProtocolClient } = await import("../dist/client.js");
  await new ProtocolClient(new URL(f.remote.url), TOKEN, 500).register(
    f.config.scope,
    session.sessionId,
    stop.signal,
  );
  await n.connectIfDue(session, stop.signal);
  for (const reason of ["closing", "drop"]) {
    if (reason === "closing") f.remote.hint("closing");
    else f.remote.sockets.at(-1).terminate();
    await sleep(20);
    assert.equal(n.healthy, false);
    assert.ok(n.nextAttempt >= now + 1000);
    now = n.nextAttempt;
    await n.connectIfDue(session, stop.signal);
    assert.equal(n.healthy, true);
  }
  assert.equal(new Set(f.remote.envelopes.map((x) => x.ticket)).size, 3);
  assert.equal(new Set(f.remote.tickets.map((x) => x.sessionId)).size, 1);
  n.stop();
  assert.equal(n.healthy, false);
});

test("aborted connect and sleeping latch clean up promptly", async (t) => {
  const f = await setup(t, { onSubscribe: () => {} });
  const stop = new AbortController();
  const run = f.run(stop.signal);
  await sleep(30);
  stop.abort();
  await assert.rejects(run, (e) => e.exitCode === 130);
  const wake = new Wakeup();
  wake.take();
  const abort = new AbortController();
  const waiting = wake.wait(60_000, abort.signal, timing);
  abort.abort();
  await assert.rejects(waiting, /abort/i);
});

test("ready timeout and upgrade redirects fall back without following", async (t) => {
  const f = await setup(t, {
    onUpgrade: (_req, socket) => {
      socket.end(
        "HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:1/PRIVATE\r\nContent-Length: 0\r\n\r\n",
      );
      return true;
    },
  });
  assert.equal(await f.run(), 0);
  assert.equal(f.remote.upgrades.length, 1);
  const g = await setup(t, { onSubscribe: () => {} });
  assert.equal(await g.run(), 0);
  assert.equal(g.remote.calls.filter((x) => x.route === "poll").length, 1);
});

test("lost hints recover queued work on the safety probe", async (t) => {
  let now = Date.now();
  const start = now;
  const f = await setup(t, { events: [], now: () => now });
  f.config.maxIdlePolls = 0;
  assert.equal(
    await f.run(undefined, {
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        now += ms;
        f.remote.queue.push(event());
      },
    }),
    0,
  );
  const probes = f.remote.calls.filter((x) => x.route === "poll");
  assert.deepEqual(
    probes.map((x) => x.at - start),
    [0, 60_000],
  );
});

test("offline notifications deliver queued work through paced HTTP fallback", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: [],
    now: () => now,
    onTicket: (_req, res) => {
      res.writeHead(503);
      res.end();
      return true;
    },
  });
  f.config.maxIdlePolls = 0;
  assert.equal(
    await f.run(undefined, {
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        assert.equal(ms, 250);
        now += ms;
        f.remote.queue.push(event());
      },
    }),
    0,
  );
  assert.equal(f.remote.tickets.length, 1);
  assert.equal(f.remote.acks.length, 1);
});

test("healthy channel cancellation during forwarding retains uncertain evidence and does not close session", async (t) => {
  const stop = new AbortController();
  const f = await setup(t, {}, async (req) => {
    await collect(req);
    stop.abort();
  });
  assert.equal(await f.run(stop.signal), 130);
  assert.equal(f.remote.acks.length, 0);
  assert.equal(
    f.remote.calls.some((x) => x.route === "close"),
    false,
  );
  assert.ok(
    f.lines.some(
      (x) => x.state === "ack_unconfirmed" && x.outcome === "uncertain",
    ),
  );
  assert.equal(getEventListeners(stop.signal, "abort").length, 0);
});

test("socket lifetime, identity reset and stale callbacks leave no abort listeners", async (t) => {
  const f = await setup(t, { events: [] });
  const stop = new AbortController();
  const wake = new Wakeup();
  const n = new Notifications(
    new URL(f.remote.url),
    TOKEN,
    500,
    wake,
    f.report,
    timing,
  );
  t.after(() => n.stop());
  const { ProtocolClient } = await import("../dist/client.js");
  const client = new ProtocolClient(new URL(f.remote.url), TOKEN, 500);
  const session = await client.register(
    f.config.scope,
    "00000000-0000-4000-8000-000000000001",
    stop.signal,
  );
  await n.connectIfDue(session, stop.signal);
  const old = n.socket;
  const stale = old.listeners("message")[0];
  assert.equal(getEventListeners(stop.signal, "abort").length, 1);
  n.reset();
  assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  await client.close(session.sessionId, stop.signal);
  const nextSession = await client.register(
    f.config.scope,
    "00000000-0000-4000-8000-000000000002",
    stop.signal,
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await n.connectIfDue(nextSession, stop.signal);
  wake.take();
  stale(Buffer.from(JSON.stringify({ version, event: "closing" })), false);
  assert.equal(n.healthy, true);
  assert.equal(wake.pending, false);
  assert.notEqual(f.remote.tickets[0].sessionId, f.remote.tickets[1].sessionId);
  t.mock.timers.tick(240_000);
  assert.equal(n.healthy, false);
  assert.ok(n.nextAttempt >= Date.now() + 999);
  n.stop();
  assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  assert.equal(old.listenerCount("message"), 0);
});

test("aborting an unfinished upgrade releases the connection without a ticket replay", async (t) => {
  const held = [];
  const f = await setup(t, {
    onUpgrade: (_req, socket) => {
      held.push(socket);
      return true;
    },
  });
  t.after(() => held.forEach((socket) => socket.destroy()));
  const stop = new AbortController();
  const run = f.run(stop.signal);
  while (!held.length) await sleep(5);
  stop.abort();
  await assert.rejects(run, (e) => e.exitCode === 130);
  assert.equal(f.remote.envelopes.length, 0);
  assert.equal(getEventListeners(stop.signal, "abort").length, 0);
});

test("ticket redirect is refused and a ticket cannot outlive its session", async (t) => {
  let redirects = 0;
  const other = await server((_req, res) => {
    redirects++;
    res.end();
  });
  t.after(() => other.close());
  const f = await setup(t, {
    onTicket: (_req, res) => {
      res.writeHead(302, { location: other.url });
      res.end();
      return true;
    },
  });
  assert.equal(await f.run(), 0);
  assert.equal(redirects, 0);
  const g = await setup(t, { sessionTtlMs: 4000, claimTtlMs: 3000 });
  assert.equal(await g.run(), 0);
  assert.equal(g.remote.upgrades.length, 0);
});

test("configured notifications retry automatically after feature-not-configured fallback", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: [],
    idleMs: 30_000,
    now: () => now,
    onTicket: (_req, res, _body, attempt) => {
      if (attempt !== 1) return false;
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ version, code: "feature_not_configured" }));
      return true;
    },
  });
  f.config.maxIdlePolls = 4;
  assert.equal(
    await f.run(undefined, {
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        now += ms;
      },
    }),
    4,
  );
  assert.equal(f.remote.tickets.length, 2);
  assert.ok(f.lines.some((x) => x.state === "notifications_ready"));
});

test("healthy notification transport retains normal HTTPS poll retry behavior", async (t) => {
  const f = await setup(t, {
    faults: { poll: [{ status: 503, code: "unavailable" }] },
  });
  assert.equal(await f.run(), 0);
  const probes = f.remote.calls.filter((x) => x.route === "poll");
  assert.equal(probes.length, 2);
  assert.ok(probes[1].at - probes[0].at < 2000);
});
