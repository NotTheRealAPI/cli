import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  configuration,
  listen,
  reporter,
  ProtocolClient,
  VERSION,
  sha256,
  ApiError,
} from "../dist/index.js";
import { cloud, server, collect, event, TOKEN, SECRET } from "./fixture.mjs";

async function setup(t, handler, options = {}, extra = []) {
  const local = await server(handler);
  const remote = await cloud(options);
  t.after(async () => {
    await local.close();
    await remote.close();
  });
  const config = await configuration(
    [
      "listen",
      "--module",
      "stripe-payments",
      "--forward-to",
      `${local.url}/webhook?test=1`,
      "--api-url",
      remote.url,
      "--allow-loopback-api",
      "--once",
      "--local-timeout-ms",
      "300",
      "--request-timeout-ms",
      "500",
      "--poll-wait-ms",
      "0",
      "--backoff-ms",
      "100",
      "--backoff-cap-ms",
      "100",
      ...extra,
    ],
    { NTAPI_LISTENER_TOKEN: TOKEN },
  );
  const lines = [];
  const output = reporter(true, (line) => lines.push(JSON.parse(line)));
  return {
    local,
    remote,
    config,
    lines,
    run: (signal) =>
      listen(config, output, signal ?? new AbortController().signal),
  };
}
test("complete fake cloud -> real socket -> ACK: bytes, signature, scope, no early ACK, no credential forwarding", async (t) => {
  const raw = Buffer.from('  {"id":"evt_reference", "text":"é🌍"}\r\n\t');
  const item = event(raw);
  let complete = false;
  const f = await setup(
    t,
    async (req, res) => {
      assert.equal(req.url, "/webhook?test=1");
      assert.deepEqual(await collect(req), raw);
      assert.equal(req.headers["stripe-signature"], item.headers[1][1]);
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers["content-length"], String(raw.length));
      const [timestamp, signature] = req.headers["stripe-signature"].split(",");
      const hmac = createHmac("sha256", SECRET)
        .update(timestamp.slice(2) + ".")
        .update(raw)
        .digest();
      assert.ok(timingSafeEqual(hmac, Buffer.from(signature.slice(3), "hex")));
      assert.notEqual(
        createHmac("sha256", SECRET)
          .update(timestamp.slice(2) + ".")
          .update(Buffer.concat([raw, Buffer.from("x")]))
          .digest("hex"),
        signature.slice(3),
      );
      await sleep(30);
      assert.equal(f.remote.acks.length, 0);
      complete = true;
      res.end("local secret must not leave this socket");
    },
    {
      events: [item],
      onAck: (ack) => {
        assert.ok(complete);
        assert.equal(ack.outcome.responseBody, "");
        assert.deepEqual(ack.outcome.responseHeaders, []);
      },
    },
  );
  assert.equal(await f.run(), 0);
  assert.equal(f.remote.acks.length, 1);
  assert.equal(f.remote.acks[0].outcome.responseComplete, true);
  assert.deepEqual(
    f.lines.map((x) => x.state),
    [
      "disconnected",
      "authenticating",
      "listening",
      "claimed",
      "forwarding",
      "ack_pending",
      "acknowledged",
    ],
  );
});
for (const status of [200, 204, 400, 429, 500, 302])
  test(`truthful local HTTP ${status}, no redirects`, async (t) => {
    let calls = 0;
    const f = await setup(t, (_req, res) => {
      calls++;
      res.writeHead(status, {
        location: "http://169.254.169.254/secret",
        "set-cookie": "secret=canary",
      });
      res.end();
    });
    assert.equal(await f.run(), status < 300 ? 0 : 5);
    const result = f.remote.acks[0].outcome;
    assert.equal(result.status, status);
    assert.equal(
      result.classification,
      status < 300 ? "success" : "http_error",
    );
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(f.lines).includes("canary"), false);
  });
for (const [name, bytes] of [
  ["UTF8 and CRLF", Buffer.from("🌈é\r\n\t  x")],
  ["binary", Buffer.from([0, 255, 254, 13, 10, 128])],
  ["empty", Buffer.alloc(0)],
])
  test(`exact raw ${name}`, async (t) => {
    const f = await setup(
      t,
      async (req, res) => {
        assert.deepEqual(await collect(req), bytes);
        res.end();
      },
      { events: [event(bytes)] },
    );
    assert.equal(await f.run(), 0);
  });
for (const [name, mutate] of [
  ["digest mismatch", (x) => ({ ...x, bodySha256: "0".repeat(64) })],
  [
    "noncanonical base64",
    (x) => ({
      ...x,
      bodyBase64: "Zh==",
      bodyBytes: 1,
      bodySha256: sha256("f"),
    }),
  ],
  ["invalid base64", (x) => ({ ...x, bodyBase64: "!!!!" })],
  ["count mismatch", (x) => ({ ...x, bodyBytes: 0 })],
  [
    "CRLF",
    (x) => ({
      ...x,
      headers: [
        ["content-type", "text/plain"],
        ["stripe-signature", "a\r\nb: c"],
      ],
    }),
  ],
  [
    "duplicate header",
    (x) => ({
      ...x,
      headers: [...x.headers, ["STRIPE-SIGNATURE", "replacement"]],
    }),
  ],
  [
    "cloud credential header",
    (x) => ({ ...x, headers: [...x.headers, ["authorization", TOKEN]] }),
  ],
  [
    "hop by hop",
    (x) => ({ ...x, headers: [...x.headers, ["connection", "close"]] }),
  ],
])
  test(`poison ${name}: no local execution, invalid payload evidence`, async (t) => {
    let calls = 0;
    const f = await setup(
      t,
      (_req, res) => {
        calls++;
        res.end();
      },
      { events: [mutate(event())] },
    );
    assert.equal(await f.run(), 5);
    assert.equal(calls, 0);
    assert.equal(f.remote.acks[0].outcome.classification, "invalid_payload");
  });
for (const [name, mutate] of [
  ["wrong version", (x) => ({ ...x, version: "unknown.v2" })],
  ["oversized body declaration", (x) => ({ ...x, bodyBytes: 1_048_577 })],
  [
    "oversized encoded body",
    (x) => ({ ...x, bodyBase64: "A".repeat(1_398_108) }),
  ],
  ["unknown fields", (x) => ({ ...x, unexpectedField: "example" })],
])
  test(`reject incompatible envelope ${name}`, async (t) => {
    const f = await setup(t, (_req, res) => res.end(), {
      mutate: (x) => (x.kind === "claim" ? mutate(x) : x),
    });
    await assert.rejects(f.run(), /protocol_mismatch|network/);
    assert.equal(f.remote.acks.length, 0);
  });
for (const [name, handler, expected] of [
  [
    "response timeout",
    async (req, _res) => {
      await collect(req);
    },
    "timeout",
  ],
  [
    "socket closes after receiving",
    async (req, _res) => {
      await collect(req);
      req.socket.destroy();
    },
    "socket",
  ],
  [
    "truncated response",
    async (req, res) => {
      await collect(req);
      res.writeHead(200, { "content-length": "100" });
      res.write("short");
      setTimeout(() => res.destroy(), 10);
    },
    "socket",
  ],
  [
    "response bound",
    async (req, res) => {
      await collect(req);
      res.end(Buffer.alloc(100_000));
    },
    "response_limit",
  ],
])
  test(`uncertain local ${name}`, async (t) => {
    const f = await setup(t, handler);
    assert.equal(await f.run(), 5);
    const outcome = f.remote.acks[0].outcome;
    assert.equal(outcome.classification, "uncertain");
    assert.equal(outcome.error, expected);
    assert.equal(outcome.responseComplete, false);
    assert.ok(outcome.responseBytes <= 65_536);
  });
test("connection refused is not local success", async (t) => {
  const f = await setup(t, (_req, res) => res.end());
  await f.local.close();
  assert.equal(await f.run(), 5);
  assert.equal(f.remote.acks[0].outcome.classification, "connection_error");
});
for (const route of ["register", "poll", "ack"])
  for (const [status, code] of [
    [401, "unauthorized"],
    [403, "forbidden"],
    [409, "stale_claim"],
    [410, "claim_expired"],
  ])
    test(`cloud ${route} ${status} is terminal`, async (t) => {
      const f = await setup(t, (_req, res) => res.end(), {
        faults: { [route]: [{ status, code }] },
      });
      await assert.rejects(f.run());
      assert.equal(f.remote.calls.filter((x) => x.route === route).length, 1);
      if (route === "ack")
        assert.ok(f.lines.some((x) => x.state === "ack_unconfirmed"));
    });
for (const route of ["register", "poll", "ack"])
  for (const fault of [
    { status: 429, code: "rate_limited", headers: { "retry-after": "0" } },
    { status: 503, code: "unavailable" },
    "disconnect",
  ])
    test(`recover ${route} ${typeof fault === "string" ? fault : fault.status}`, async (t) => {
      const f = await setup(t, (_req, res) => res.end(), {
        faults: { [route]: [fault] },
      });
      assert.equal(await f.run(), 0);
      assert.equal(f.remote.acks.length, 1);
      assert.ok(f.lines.some((x) => x.state === "backoff"));
    });
test("lost ACK receipt: retry same key, one handler effect, one recorded outcome", async (t) => {
  let effects = 0;
  const f = await setup(
    t,
    (_req, res) => {
      effects++;
      res.end();
    },
    { faults: { ack: ["lost_receipt"] } },
  );
  assert.equal(await f.run(), 0);
  assert.equal(effects, 1);
  assert.equal(f.remote.acks.length, 1);
  assert.equal(f.remote.calls.filter((x) => x.route === "ack").length, 2);
});
test("provider redelivery retains provider bytes/signature with distinct delivery/attempt", async (t) => {
  const original = event();
  const again = {
    ...original,
    deliveryId: "delivery_second",
    attemptId: "attempt_second",
    attempt: 2,
  };
  const received = [];
  const f = await setup(
    t,
    async (req, res) => {
      received.push({
        body: await collect(req),
        signature: req.headers["stripe-signature"],
      });
      res.end();
    },
    { events: [original, again] },
    ["--max-idle-polls", "1"],
  );
  f.config.once = false;
  assert.equal(await f.run(), 4);
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], received[1]);
  assert.equal(f.remote.acks.length, 2);
  assert.notEqual(f.remote.acks[0].attemptId, f.remote.acks[1].attemptId);
});
test("expired session refreshes registration", async (t) => {
  let f;
  f = await setup(t, (_req, res) => res.end(), {
    faults: {
      poll: [
        (_req, res) => {
          f.remote.expireSession();
          res.writeHead(410, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ version: VERSION, code: "session_expired" }),
          );
          return true;
        },
      ],
    },
  });
  assert.equal(await f.run(), 0);
  assert.equal(f.remote.calls.filter((x) => x.route === "register").length, 2);
});
test("revocation while polling stops immediately", async (t) => {
  let f;
  f = await setup(t, (_req, res) => res.end(), {
    faults: {
      poll: [
        (req) => {
          f.remote.revoke();
          req.socket.destroy();
          return true;
        },
      ],
    },
  });
  await assert.rejects(f.run(), /unauthorized/);
  assert.equal(f.remote.acks.length, 0);
});
test("short or expired lease never reaches local endpoint", async (t) => {
  let calls = 0;
  const f = await setup(
    t,
    (_req, res) => {
      calls++;
      res.end();
    },
    { claimTtlMs: 10 },
  );
  await assert.rejects(f.run(), /claim_expired/);
  assert.equal(calls, 0);
});
test("dual listener conflict and wrong scope enforced by reference service", async (t) => {
  const f = await setup(t, (_req, res) => res.end());
  const client = new ProtocolClient(new URL(f.remote.url), TOKEN, 500);
  const signal = new AbortController().signal;
  await client.register(
    f.config.scope,
    "00000000-0000-4000-8000-000000000001",
    signal,
  );
  await assert.rejects(f.run(), /session_conflict/);
  const remote = await cloud({ scope: { ...f.config.scope, module: "other" } });
  t.after(remote.close);
  f.config.api = new URL(remote.url);
  await assert.rejects(f.run(), /forbidden/);
});
test("cancellation in flight emits uncertain outcome without false ACK", async (t) => {
  const stop = new AbortController();
  const f = await setup(t, async (req, _res) => {
    await collect(req);
    stop.abort();
  });
  assert.equal(await f.run(stop.signal), 130);
  assert.equal(f.remote.acks.length, 0);
  assert.ok(
    f.lines.some(
      (x) => x.state === "ack_unconfirmed" && x.outcome === "uncertain",
    ),
  );
});
test("bounded idle polling and --once idle result", async (t) => {
  const f = await setup(t, (_req, res) => res.end(), { events: [] });
  assert.equal(await f.run(), 4);
  assert.equal(f.remote.calls.filter((x) => x.route === "poll").length, 1);
  f.config.maxIdlePolls = 3;
  const waits = [];
  const clock = {
    now: Date.now,
    random: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
  assert.equal(
    await listen(f.config, () => {}, new AbortController().signal, clock),
    4,
  );
  assert.deepEqual(waits, [250, 250]);
});
test("executable --once, JSON privacy, malicious local response is never uplinked", async (t) => {
  const canary = "CANARY_PRIVATE_RESPONSE";
  const f = await setup(t, (_req, res) => {
    res.setHeader("x-secret", canary);
    res.end(canary);
  });
  const child = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "listen",
      "--module",
      "stripe-payments",
      "--forward-to",
      f.local.url + "/secret?token=PRIVATE_QUERY",
      "--api-url",
      f.remote.url,
      "--allow-loopback-api",
      "--once",
      "--json",
    ],
    {
      env: {
        ...process.env,
        NTAPI_LISTENER_TOKEN: TOKEN,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
        NODE_USE_ENV_PROXY: "1",
      },
    },
  );
  let output = "";
  child.stdout.on("data", (x) => {
    output += x;
  });
  child.stderr.on("data", (x) => {
    output += x;
  });
  assert.equal(
    await new Promise((resolve) => child.on("exit", resolve)),
    0,
    output,
  );
  output
    .trim()
    .split("\n")
    .forEach((x) => JSON.parse(x));
  for (const secret of [
    canary,
    TOKEN,
    SECRET,
    "PRIVATE_QUERY",
    f.local.url,
    f.remote.url,
  ])
    assert.equal(output.includes(secret), false);
  assert.equal(JSON.stringify(f.remote.acks).includes(canary), false);
});

for (const route of ["poll", "ack"])
  test(`cloud ${route} timeout reconnects without another local execution`, async (t) => {
    let effects = 0;
    const f = await setup(
      t,
      (_req, res) => {
        effects++;
        res.end();
      },
      { faults: { [route]: [() => true] } },
    );
    assert.equal(await f.run(), 0);
    assert.equal(effects, 1);
    assert.ok(f.lines.some((x) => x.state === "backoff"));
  });
test("Retry-After minimum is honored using injected clock", async (t) => {
  const f = await setup(t, (_req, res) => res.end(), {
    faults: {
      poll: [
        { status: 429, code: "rate_limited", headers: { "retry-after": "2" } },
      ],
    },
  });
  const waits = [];
  assert.equal(
    await listen(f.config, () => {}, new AbortController().signal, {
      now: Date.now,
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
    0,
  );
  assert.deepEqual(waits, [2000]);
});
test("permanent cloud failures stop after eight retries using accelerated clock", async (t) => {
  const f = await setup(t, (_req, res) => res.end(), {
    faults: {
      poll: Array.from({ length: 9 }, () => ({
        status: 503,
        code: "unavailable",
      })),
    },
  });
  let waits = 0;
  await assert.rejects(
    listen(f.config, () => {}, new AbortController().signal, {
      now: Date.now,
      random: () => 0,
      sleep: async () => {
        waits++;
      },
    }),
    /unavailable/,
  );
  assert.equal(waits, 8);
  assert.equal(f.remote.calls.filter((x) => x.route === "poll").length, 9);
});
test("ACK lease deadline preserves local evidence and stops before retry after expiry", async (t) => {
  const f = await setup(t, (_req, res) => res.end(), {
    faults: { ack: [{ status: 503, code: "unavailable" }] },
  });
  let now = Date.now();
  await assert.rejects(
    listen(f.config, () => {}, new AbortController().signal, {
      now: () => now,
      random: () => 0,
      sleep: async () => {
        now += 120_000;
      },
    }),
    /ack_unconfirmed_lease_expired/,
  );
  assert.equal(f.remote.calls.filter((x) => x.route === "ack").length, 1);
  assert.equal(f.remote.acks.length, 0);
});
test("duplicate identical claim uses cached ACK and never repeats local effect", async (t) => {
  const item = event();
  let first;
  let effects = 0;
  const f = await setup(
    t,
    (_req, res) => {
      effects++;
      res.end();
    },
    {
      events: [item],
      faults: {
        poll: [
          () => false,
          (_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(first));
            return true;
          },
        ],
      },
      mutate: (x) => {
        if (x.kind !== "claim") return x;
        first ??= x;
        return first;
      },
    },
    ["--max-idle-polls", "1"],
  );
  f.config.once = false;
  assert.equal(await f.run(), 4);
  assert.equal(effects, 1);
  assert.equal(f.remote.acks.length, 1);
  assert.equal(f.lines.filter((x) => x.state === "acknowledged").length, 2);
});
test("changed fencing generation on same attempt stops without a second local effect", async (t) => {
  const item = event();
  let effects = 0;
  const f = await setup(
    t,
    (_req, res) => {
      effects++;
      res.end();
    },
    { events: [item, item] },
    ["--max-idle-polls", "1"],
  );
  f.config.once = false;
  await assert.rejects(f.run(), /attempt_generation_changed/);
  assert.equal(effects, 1);
});
test("reference service rejects stale, expired, and changed idempotency evidence", async (t) => {
  const f = await setup(t, (_req, res) => res.end());
  assert.equal(await f.run(), 0);
  // Register a fresh authorized session, acquire a claim, then exercise the raw contract.
  const client = new ProtocolClient(new URL(f.remote.url), TOKEN, 500),
    signal = new AbortController().signal;
  const sessionId = "00000000-0000-4000-8000-000000000099";
  await client.register(f.config.scope, sessionId, signal);
  f.remote.queue.push(event());
  const claim = await client.poll(sessionId, 0, signal);
  const ack = {
    ...f.remote.acks[0],
    sessionId,
    attemptId: claim.attemptId,
    deliveryId: claim.deliveryId,
    claimToken: claim.claimToken,
    generation: claim.generation,
    ackKey: "00000000-0000-4000-8000-000000000098",
  };
  await assert.rejects(
    client.ack({ ...ack, generation: claim.generation + 1 }, signal),
    (e) => e instanceof ApiError && e.status === 409,
  );
  const stored = f.remote.claims.get(claim.attemptId);
  stored.expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(
    client.ack(ack, signal),
    (e) => e instanceof ApiError && e.status === 410,
  );
  stored.expiresAt = new Date(Date.now() + 10000).toISOString();
  await client.ack(ack, signal);
  await assert.rejects(
    client.ack({ ...ack, outcome: { ...ack.outcome, status: 500 } }, signal),
    (e) => e instanceof ApiError && e.status === 409,
  );
});
test("session renewal uses the same identity and does not create takeover conflict", async (t) => {
  let now = Date.now(),
    bumped = false;
  const f = await setup(t, (_req, res) => res.end(), {
    events: [],
    sessionTtlMs: 4000,
    now: () => now,
  });
  f.config.maxIdlePolls = 2;
  assert.equal(
    await listen(f.config, () => {}, new AbortController().signal, {
      now: () => now,
      random: () => 0,
      sleep: async () => {
        if (!bumped) {
          now += 2500;
          bumped = true;
        }
      },
    }),
    4,
  );
  assert.equal(f.remote.calls.filter((x) => x.route === "register").length, 2);
});
test("explicit IPv6 loopback forwards to a real socket when the OS provides IPv6", async (t) => {
  const http = await import("node:http");
  const instance = http.createServer(async (req, res) => {
    await collect(req);
    res.end();
  });
  try {
    await new Promise((resolve, reject) => {
      instance.once("error", reject);
      instance.listen(0, "::1", resolve);
    });
  } catch (e) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(e.code)) {
      t.skip("OS has no IPv6 loopback");
      return;
    }
    throw e;
  }
  t.after(
    () =>
      new Promise((resolve) => {
        instance.close(resolve);
        instance.closeAllConnections();
      }),
  );
  const f = await setup(t, (_req, res) => res.end());
  f.config.target = new URL(`http://[::1]:${instance.address().port}/`);
  assert.equal(await f.run(), 0);
});
test("SIGTERM actual subprocess in flight exits 130 and never sends success ACK", async (t) => {
  let child;
  let received;
  const ready = new Promise((resolve) => {
    received = resolve;
  });
  const f = await setup(t, async (req, _res) => {
    await collect(req);
    received();
  });
  child = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "listen",
      "--module",
      "stripe-payments",
      "--forward-to",
      f.local.url,
      "--api-url",
      f.remote.url,
      "--allow-loopback-api",
      "--once",
      "--json",
    ],
    { env: { ...process.env, NTAPI_LISTENER_TOKEN: TOKEN } },
  );
  let output = "";
  child.stdout.on("data", (x) => {
    output += x;
  });
  child.stderr.on("data", (x) => {
    output += x;
  });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  await ready;
  child.kill("SIGTERM");
  const code = await exit;
  // Windows TerminateProcess cannot deliver a catchable SIGTERM to Node.
  if (process.platform === "win32") assert.notEqual(code, 0);
  else {
    assert.equal(code, 130);
    assert.match(output, /ack_unconfirmed/);
  }
  assert.equal(f.remote.acks.length, 0);
});

test("independent receiver rejects tampered body despite a valid transport digest", async (t) => {
  const original = event(Buffer.from("signed bytes"));
  const tampered = Buffer.from("tampered bytes");
  const item = {
    ...original,
    bodyBase64: tampered.toString("base64"),
    bodyBytes: tampered.length,
    bodySha256: sha256(tampered),
  };
  const f = await setup(
    t,
    async (req, res) => {
      const bytes = await collect(req);
      const [time, sig] = req.headers["stripe-signature"].split(",");
      const actual = createHmac("sha256", SECRET)
        .update(time.slice(2) + ".")
        .update(bytes)
        .digest("hex");
      res.writeHead(actual === sig.slice(3) ? 204 : 400);
      res.end();
    },
    { events: [item] },
  );
  assert.equal(await f.run(), 5);
  assert.equal(f.remote.acks[0].outcome.status, 400);
});
test("malicious event metadata cannot echo the known authentication token", async (t) => {
  const f = await setup(t, (_req, res) => res.end(), {
    events: [event(undefined, { eventId: TOKEN, eventType: TOKEN })],
  });
  assert.equal(await f.run(), 0);
  assert.equal(JSON.stringify(f.lines).includes(TOKEN), false);
});
for (const options of [
  { enabled: false },
  { allowedActions: ["register"] },
  { tokenExpiresAt: 0 },
])
  test(`reference authorization gate ${Object.keys(options)[0]}`, async (t) => {
    const f = await setup(t, (_req, res) => res.end(), options);
    await assert.rejects(f.run(), /unauthorized|forbidden/);
    assert.equal(f.remote.acks.length, 0);
  });

test("maximum 1 MiB event is validated and relayed byte for byte", async (t) => {
  const bytes = Buffer.alloc(1_048_576, 0xa5);
  const f = await setup(
    t,
    async (req, res) => {
      assert.deepEqual(await collect(req), bytes);
      res.end();
    },
    { events: [event(bytes)] },
  );
  f.config.localTimeoutMs = 1000;
  f.config.requestTimeoutMs = 2000;
  assert.equal(await f.run(), 0);
  assert.equal(f.remote.acks[0].outcome.requestBytes, 1_048_576);
});
test("session cache rotation supports sustained execution beyond 256 claims", async (t) => {
  let effects = 0;
  const f = await setup(
    t,
    async (req, res) => {
      await collect(req);
      effects++;
      res.end();
    },
    { events: Array.from({ length: 257 }, () => event(Buffer.from("x"))) },
    ["--max-idle-polls", "1"],
  );
  f.config.once = false;
  assert.equal(await f.run(), 4);
  assert.equal(effects, 257);
  assert.equal(f.remote.acks.length, 257);
  assert.equal(f.remote.calls.filter((x) => x.route === "register").length, 2);
});
