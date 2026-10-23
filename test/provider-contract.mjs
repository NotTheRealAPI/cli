import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { URLSearchParams } from "node:url";
import twilio from "twilio";
import { Signature } from "@hubspot/api-client";
import OpenAI from "openai";
import { cloud, server, collect, SECRET, TOKEN } from "./fixture.mjs";
import { delivery, runBin } from "./v2-fixture.mjs";

const signedUrl =
  "https://callbacks.example.test/private/webhook?route=%2Ftest&text=%C3%A9&keep=a+b";
// HubSpot v3 decodes this exact documented set, not decodeURIComponent(uri).
const hubspotUri = (url) =>
  url.replace(/%(3a|2f|3f|40|21|24|27|28|29|2a|2c|3b)/gi, (x) =>
    String.fromCharCode(parseInt(x.slice(1), 16)),
  );
const hmac = (algorithm, value, encoding = "base64", key = SECRET) =>
  createHmac(algorithm, key).update(value).digest(encoding);

export function providerFixtures() {
  const futureHeaders = [
    "X-Future-Signature",
    "X-Future-Timestamp",
    "X-Future-Correlation",
  ];
  const renamedHeaders = ["X-Orbit-Proof", "X-Orbit-Time", "X-Orbit-Trace"];
  const cases = [];
  for (const names of [futureHeaders, renamedHeaders])
    for (const [mediaType, body] of [
      ["application/json; charset=utf-8", Buffer.from(' {"future":"é🌍"}\r\n')],
      ["application/octet-stream", Buffer.from([0, 255, 254, 13, 10, 128])],
      [
        "application/x-www-form-urlencoded",
        Buffer.from("greeting=%C3%A9%F0%9F%8C%8D&plus=a%2Bb&space=a+b"),
      ],
      [undefined, Buffer.alloc(0)],
    ]) {
      const values = [
        "opaque=Case, With== punctuation",
        "1893456000",
        "Case-Sensitive_123",
      ];
      const headers = names.map((name, i) => [name, values[i]]);
      if (mediaType) headers.push(["Content-Type", mediaType]);
      cases.push({
        name: `${names[0]}:${mediaType ?? "absent"}`,
        body,
        headers,
      });
    }
  const form = Buffer.from(
    "Body=h%C3%A9llo+%F0%9F%8C%8D%2B&From=%2B15005550006&To=%2B15005550009",
  );
  const params = Object.fromEntries(new URLSearchParams(form.toString()));
  const input =
    signedUrl +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  const twilioSignature = hmac("sha1", input);
  cases.push({
    name: "Twilio form",
    body: form,
    verificationUrl: signedUrl,
    headers: [
      ["Content-Type", "application/x-www-form-urlencoded; charset=utf-8"],
      ["X-Twilio-Signature", twilioSignature],
    ],
    verify: async (req, body, localUrl) => {
      const url = req.headers["x-ntapi-listener-verification-url"];
      const fields = Object.fromEntries(new URLSearchParams(body.toString()));
      assert.equal(
        twilio.validateRequest(
          SECRET,
          req.headers["x-twilio-signature"],
          url,
          fields,
        ),
        true,
      );
      for (const wrong of [
        url.replace("/private/webhook", "/wrong"),
        url + "&changed=1",
        localUrl,
      ])
        assert.equal(
          twilio.validateRequest(
            SECRET,
            req.headers["x-twilio-signature"],
            wrong,
            fields,
          ),
          false,
        );
      assert.equal(
        twilio.validateRequest(SECRET, req.headers["x-twilio-signature"], url, {
          ...fields,
          Body: "tampered",
        }),
        false,
      );
    },
  });
  const json = Buffer.from(' [{"eventId":1,"propertyValue":"héllo 🌍"}]\r\n');
  const stamp = String(Date.now());
  cases.push({
    name: "HubSpot v3",
    body: json,
    verificationUrl: signedUrl,
    headers: [
      ["Content-Type", "application/json"],
      [
        "X-HubSpot-Signature-v3",
        hmac(
          "sha256",
          "POST" + hubspotUri(signedUrl) + json.toString() + stamp,
        ),
      ],
      ["X-HubSpot-Request-Timestamp", stamp],
    ],
    verify: async (req, body, localUrl) => {
      const url = req.headers["x-ntapi-listener-verification-url"];
      const options = {
        method: "POST",
        signatureVersion: "v3",
        clientSecret: SECRET,
        requestBody: body.toString(),
        timestamp: Number(req.headers["x-hubspot-request-timestamp"]),
        signature: req.headers["x-hubspot-signature-v3"],
      };
      assert.equal(
        Signature.isValid({ ...options, url: hubspotUri(url) }),
        true,
      );
      for (const wrong of [
        url.replace("/private/webhook", "/wrong"),
        url + "&changed=1",
        localUrl,
      ])
        assert.equal(
          Signature.isValid({ ...options, url: hubspotUri(wrong) }),
          false,
        );
      assert.equal(
        Signature.isValid({
          ...options,
          url: hubspotUri(url),
          requestBody: body + " ",
        }),
        false,
      );
    },
  });
  const auth = "synthetic_registered_header_value";
  cases.push({
    name: "Dataverse registered HttpHeader auth",
    body: Buffer.from(
      '{"MessageName":"Create","InputParameters":[{"key":"Target","value":"é"}]}',
    ),
    headers: [
      ["Content-Type", "application/json; charset=utf-8"],
      ["X-Registered-Dataverse-Key", auth],
      ["x-ms-correlation-request-id", "synthetic-correlation"],
    ],
    verify: async (req) =>
      assert.ok(
        timingSafeEqual(
          Buffer.from(req.headers["x-registered-dataverse-key"]),
          Buffer.from(auth),
        ),
      ),
  });
  const raw = Buffer.from(
    ' {"id":"evt_synthetic","type":"response.completed","data":{"id":"resp_synthetic","text":"é🌍"}}\n',
  );
  const seconds = String(Math.floor(Date.now() / 1000));
  const messageId = "msg_synthetic_0123456789";
  const key = Buffer.from("synthetic_openai_key_0123456789");
  const webhookSecret = "whsec_" + key.toString("base64");
  const openai = new OpenAI({
    apiKey: "synthetic_unused_api_key",
    webhookSecret,
  });
  cases.push({
    name: "OpenAI Standard Webhooks",
    body: raw,
    headers: [
      ["Content-Type", "application/json"],
      ["webhook-id", messageId],
      ["webhook-timestamp", seconds],
      [
        "webhook-signature",
        "v1," +
          hmac(
            "sha256",
            `${messageId}.${seconds}.${raw.toString()}`,
            "base64",
            key,
          ),
      ],
    ],
    verify: async (req, body) => {
      await openai.webhooks.verifySignature(body.toString(), req.headers);
      await assert.rejects(
        openai.webhooks.verifySignature(body + " ", req.headers),
      );
      await assert.rejects(
        openai.webhooks.verifySignature(body.toString(), {
          ...req.headers,
          "webhook-id": "changed",
        }),
      );
    },
  });
  const stripeBody = Buffer.from(' {"id":"evt_stripe","text":"é🌍"}\n');
  cases.push({
    name: "Stripe V2",
    body: stripeBody,
    headers: [
      ["Content-Type", "application/json"],
      [
        "Stripe-Signature",
        `t=${seconds},v1=${hmac("sha256", `${seconds}.${stripeBody.toString()}`, "hex")}`,
      ],
    ],
    verify: async (req, body) =>
      assert.equal(
        req.headers["stripe-signature"],
        `t=${seconds},v1=${hmac("sha256", Buffer.concat([Buffer.from(seconds + "."), body]), "hex")}`,
      ),
  });
  return cases;
}

// Called unchanged by source tests and by the freshly installed tarball smoke.
export async function providerContract(bin, cwd) {
  const cases = providerFixtures();
  for (const fixture of cases) {
    let effects = 0;
    let local;
    local = await server(async (req, res) => {
      try {
        const body = await collect(req);
        assert.deepEqual(body, fixture.body, fixture.name);
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/fixed?local=1");
        assert.equal(req.headers.host, new URL(local.url).host);
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers.cookie, undefined);
        assert.equal(req.headers["content-length"], String(body.length));
        assert.equal(
          req.headers["content-type"],
          fixture.headers.find(
            ([name]) => name.toLowerCase() === "content-type",
          )?.[1],
        );
        for (const [name, value] of fixture.headers)
          assert.equal(req.headers[name.toLowerCase()], value);
        assert.equal(
          req.headers["x-ntapi-listener-verification-url"],
          fixture.verificationUrl,
        );
        await fixture.verify?.(req, body, local.url + req.url);
        effects++;
        res.writeHead(204);
        res.end();
      } catch (error) {
        res.writeHead(400);
        res.end();
        local.failure = error;
      }
    });
    const item = delivery(fixture.body, {
      headers: fixture.headers,
      ...(fixture.verificationUrl
        ? { verificationUrl: fixture.verificationUrl }
        : {}),
    });
    const remote = await cloud({
      protocol: "v2",
      events: [item],
      faults: { ack: ["lost_receipt"] },
    });
    try {
      const result = await runBin(bin, remote, local.url + "/fixed?local=1", {
        cwd,
        extra: fixture.verificationUrl ? ["--include-verification-url"] : [],
      });
      if (local.failure) throw local.failure;
      assert.equal(result.code, 0, `${fixture.name}: ${result.stderr}`);
      assert.equal(effects, 1);
      assert.equal(remote.acks.length, 1);
      assert.equal(remote.acks[0].version, "ntapi.listener.v2");
      assert.equal(remote.acks[0].outcome.classification, "success");
      assert.equal(remote.calls.filter((x) => x.route === "ack").length, 2);
      assert.equal(remote.calls.at(-1).route, "close");
      const evidence =
        result.stdout + result.stderr + JSON.stringify(remote.acks);
      for (const secret of [
        SECRET,
        TOKEN,
        signedUrl,
        "private/webhook",
        "synthetic_registered_header_value",
        item.headers[0][1],
      ]) {
        // Media types are not secrets, but are also intentionally absent from evidence.
        assert.equal(evidence.includes(secret), false, fixture.name);
      }
    } finally {
      await remote.close();
      await local.close();
    }
  }
  return `provider-agnostic-contract: ${cases.length} fixtures, changing unknown headers, exact bodies, SDK verification, lost ACK recovery`;
}
