import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFile } from "node:fs/promises";
import * as v1 from "../dist/protocol.js";
import * as v2 from "../dist/protocol-v2.js";
import { ProtocolClient, configuration } from "../dist/index.js";
import { server, collect, TOKEN } from "./fixture.mjs";
import { delivery, setupV2, runBin } from "./v2-fixture.mjs";

const forbidden = [
  "Host",
  "Content-Length",
  "Transfer-Encoding",
  "Connection",
  "Upgrade",
  "Proxy-Anything",
  "TE",
  "Trailer",
  "Keep-Alive",
  "Authorization",
  "Proxy-Authorization",
  "Cookie",
  "Set-Cookie",
  "Forwarded",
  "X-Forwarded-Host",
  "X-Forwarded-Whatever",
  "Expect",
  "Content-Encoding",
  "Accept-Encoding",
  "Sec-Fetch-Site",
  "Sec-WebSocket-Key",
  "X-HTTP-Method-Override",
  "X-Method-Override",
  "X-HTTP-Method",
  "X-Original-URL",
  "X-Rewrite-URL",
  "Via",
  "X-Real-IP",
  "WWW-Authenticate",
  "Authentication-Info",
  "Max-Forwards",
  "X-URL-Scheme",
  "Front-End-Https",
  "X-Ntapi-Listener-Verification-URL",
];
const hostile = [
  ...forbidden.map((name) => [name, [[name, "CANARY_PRIVATE"]]]),
  [
    "duplicates",
    [
      ["X-Unknown", "one"],
      ["x-UNKNOWN", "two"],
    ],
  ],
  ...[
    "\r\nInjected: yes",
    "nul\0",
    "tab\t",
    "control\x1f",
    "del\x7f",
    "é",
    "🌍",
  ].map((value) => [JSON.stringify(value), [["X-Unknown", value]]]),
  ...["invalid name", "colon:", "", "é", "x".repeat(65)].map((name) => [
    JSON.stringify(name),
    [[name, "x"]],
  ]),
  ["value bound", [["X-Unknown", "x".repeat(1025)]]],
  ["count bound", Array.from({ length: 25 }, (_, i) => [`X-H-${i}`, "x"])],
  [
    "aggregate bound",
    Array.from({ length: 9 }, (_, i) => [`X-H-${i}`, "x".repeat(1024)]),
  ],
];
for (const [name, headers] of hostile)
  test(`v2 hostile header ${name}: no socket, no leaking diagnostics`, async (t) => {
    let calls = 0;
    const local = await server((_req, res) => {
      calls++;
      res.end();
    });
    t.after(local.close);
    const f = await setupV2(t, local.url, {
      events: [delivery(undefined, { headers })],
    });
    const result = await runBin("dist/cli.js", f.remote, local.url);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(calls, 0);
    assert.equal(f.remote.acks.length, 0);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /CANARY_PRIVATE|Injected|é|🌍/,
    );
    assert.match(result.stderr, /protocol_mismatch/);
  });

for (const [name, change] of [
  [
    "noncanonical",
    { bodyBase64: "Zh==", bodyBytes: 1, bodySha256: v1.sha256("f") },
  ],
  ["invalid encoding", { bodyBase64: "!!!!" }],
  ["digest mismatch", { bodySha256: "0".repeat(64) }],
  ["byte count", { bodyBytes: 0 }],
])
  test(`v2 body ${name}: invalid payload ACK without forwarding`, async (t) => {
    let calls = 0;
    const local = await server((_req, res) => {
      calls++;
      res.end();
    });
    t.after(local.close);
    const f = await setupV2(t, local.url, {
      events: [delivery(undefined, change)],
    });
    assert.equal(await f.run(), 5);
    assert.equal(calls, 0);
    assert.equal(f.remote.acks[0].outcome.classification, "invalid_payload");
  });

for (const verificationUrl of [
  "http://public.test/",
  "http://127.0.0.1/",
  "https://u:p@public.test/",
  "https://public.test/#x",
  "https://public.test/#",
  "https://PUBLIC.test/",
  "https://public.test",
  "https://public.test/\r\nsecret",
  "https://public.test/é",
  "https://public.test/%xx",
  "https://public.test/" + "x".repeat(2048),
])
  test(`v2 rejects malformed signing URL ${JSON.stringify(verificationUrl).slice(0, 65)}`, () => {
    assert.equal(
      v2.claimSchema.safeParse(delivery(undefined, { verificationUrl }))
        .success,
      false,
    );
  });

test("v2 metadata is opt-in, never a destination or ACK/log evidence", async (t) => {
  const verificationUrl =
    "https://never-contact.invalid/private?canary=PRIVATE_SIGNING_INPUT";
  let calls = 0;
  const local = await server(async (req, res) => {
    calls++;
    await collect(req);
    assert.equal(req.headers[v2.VERIFICATION_URL_HEADER], undefined);
    res.end();
  });
  t.after(local.close);
  const f = await setupV2(t, local.url, {
    events: [delivery(undefined, { verificationUrl })],
  });
  const result = await runBin("dist/cli.js", f.remote, local.url);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls, 1);
  assert.doesNotMatch(
    result.stdout + result.stderr + JSON.stringify(f.remote.acks),
    /PRIVATE_SIGNING_INPUT|never-contact|verificationUrl/,
  );
});

test("v2 raw wire preserves header name casing and printable values including whitespace", async (t) => {
  let received = "";
  const instance = net.createServer((socket) =>
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (received.includes("\r\n\r\n"))
        socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    }),
  );
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const headers = [
    ["X-Mixed-Case", "  One, Two==  "],
    ["__proto__", "opaque"],
  ];
  const f = await setupV2(t, `http://127.0.0.1:${instance.address().port}/`, {
    events: [delivery(Buffer.alloc(0), { headers })],
  });
  assert.equal(await f.run(), 0);
  assert.ok(received.includes("X-Mixed-Case:   One, Two==  \r\n"));
  assert.ok(received.includes("__proto__: opaque\r\n"));
  assert.ok(received.includes("content-length: 0\r\n"));
  assert.equal(received.toLowerCase().includes("content-type:"), false);
});

test("v2 exported schemas, fixture, runtime bounds and frozen V1 fixtures", async () => {
  for (const [version, p] of [
    ["v1", v1],
    ["v2", v2],
  ]) {
    const fixtures = JSON.parse(
      await readFile(
        new URL(`../docs/fixtures/${version}.json`, import.meta.url),
        "utf8",
      ),
    );
    for (const [name, data] of Object.entries(fixtures)) p[name].parse(data);
    assert.ok(p.decodePayload(fixtures.claimSchema).body.length >= 0);
  }
  for (const [file, digest] of [
    [
      "fixtures/v1.json",
      "5a9ef64ee75d85e514bb1bd63dc257363e3849db0b9cfb1fb67302a3e00c38af",
    ],
    [
      "protocol-v1.schema.json",
      "2dfbe43402ff47706b332a71aa06893791d2d43503940f20a131c1b3c548d837",
    ],
  ]) {
    assert.equal(
      v1.sha256(
        (
          await readFile(new URL(`../docs/${file}`, import.meta.url), "utf8")
        ).replaceAll("\r\n", "\n"),
      ),
      digest,
      "Published V1 contract must remain frozen",
    );
  }
  assert.equal(v1.claimSchema.safeParse(delivery()).success, false);
  assert.equal(
    v2.claimSchema.safeParse({ ...delivery(), method: "GET" }).success,
    false,
  );
  const headers = Array.from({ length: 24 }, (_, i) => [`X-H-${i}`, "x"]);
  assert.ok(v2.decodePayload(delivery(undefined, { headers })));
  assert.ok(
    v2.decodePayload(
      delivery(undefined, { headers: [["x", "x".repeat(1024)]] }),
    ),
  );
  assert.ok(
    v2.decodePayload(
      delivery(undefined, {
        headers: Array.from({ length: 8 }, (_, i) => [
          `x${i}`,
          "x".repeat(1022),
        ]),
      }),
    ),
  );
  assert.throws(() =>
    v2.decodePayload(
      delivery(undefined, {
        headers: Array.from({ length: 8 }, (_, i) => [
          `x${i}`,
          "x".repeat(1023),
        ]),
      }),
    ),
  );
});

for (const [label, status, response] of [
  [
    "v1 downgrade claim",
    200,
    { version: "ntapi.listener.v1", kind: "idle", retryAfterMs: 250 },
  ],
  ["unknown version", 200, { version: "ntapi.listener.v99" }],
  [
    "explicit v1-only error",
    409,
    { version: "ntapi.listener.v1", code: "version_mismatch" },
  ],
  ["unauthorized", 401, { version: "ntapi.listener.v2", code: "unauthorized" }],
  ["forbidden", 403, { version: "ntapi.listener.v2", code: "forbidden" }],
  ["ambiguous", 200, {}],
  ["corrupt", 200, "not JSON"],
  ["timeout", 0, {}],
])
  test(`v2 selection ${label}: never downgrade or attempt v1`, async (t) => {
    const calls = [];
    const remote = await server(async (req, res) => {
      calls.push(req.url);
      await collect(req);
      if (!status) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        typeof response === "string" ? response : JSON.stringify(response),
      );
    });
    t.after(remote.close);
    const client = new ProtocolClient(new URL(remote.url), TOKEN, 100, "v2");
    await assert.rejects(
      client.register(
        { module: "any", environment: "preview", destination: "0".repeat(64) },
        "00000000-0000-4000-8000-000000000001",
        new AbortController().signal,
      ),
    );
    assert.deepEqual(calls, ["/listener/v2/sessions"]);
  });

test("CLI default V2 and explicit legacy selection are strict and scoped identically", async () => {
  const args = [
    "listen",
    "--module",
    "any",
    "--forward-to",
    "http://localhost:3000/a?b=1",
  ];
  const modern = await configuration(args, { NTAPI_LISTENER_TOKEN: TOKEN });
  const legacy = await configuration([...args, "--protocol", "v1"], {
    NTAPI_LISTENER_TOKEN: TOKEN,
  });
  assert.equal(modern.protocol, "v2");
  assert.equal(legacy.protocol, "v1");
  assert.deepEqual(modern.scope, legacy.scope);
  await assert.rejects(
    configuration([...args, "--protocol", "auto"], {
      NTAPI_LISTENER_TOKEN: TOKEN,
    }),
    /invalid_protocol/,
  );
  await assert.rejects(
    configuration([...args, "--protocol", "v1", "--include-verification-url"], {
      NTAPI_LISTENER_TOKEN: TOKEN,
    }),
    /requires_v2/,
  );
});

test("v2 lost committed claim reply replays the identical claim with one local execution", async (t) => {
  let effects = 0;
  const local = await server(async (req, res) => {
    await collect(req);
    effects++;
    res.end();
  });
  t.after(local.close);
  const offered = [];
  const f = await setupV2(t, local.url, {
    events: [delivery()],
    faults: {
      poll: [
        (req, res) => {
          // Lose the reply only after the reference service creates its outstanding claim.
          res.end = () => {
            req.socket.destroy();
            return res;
          };
          return false;
        },
      ],
    },
    mutate: (value) => {
      if (value.kind === "claim")
        offered.push(JSON.parse(JSON.stringify(value)));
      return value;
    },
  });
  assert.equal(await f.run(), 0);
  assert.equal(effects, 1);
  assert.equal(f.remote.acks.length, 1);
  assert.equal(offered.length, 2);
  assert.deepEqual(offered[0], offered[1]);
});

for (const field of [
  "forwardTo",
  "destinationUrl",
  "proxy",
  "hostname",
  "provider",
])
  test(`v2 claim cannot supply ${field}`, async (t) => {
    let effects = 0;
    const local = await server((_req, res) => {
      effects++;
      res.end();
    });
    t.after(local.close);
    const f = await setupV2(t, local.url, {
      events: [
        delivery(undefined, {
          [field]: "https://never-contact.invalid/PRIVATE_ROUTE",
        }),
      ],
    });
    await assert.rejects(f.run(), /protocol_mismatch/);
    assert.equal(effects, 0);
    assert.equal(f.remote.acks.length, 0);
    assert.doesNotMatch(JSON.stringify(f.lines), /PRIVATE_ROUTE/);
  });
