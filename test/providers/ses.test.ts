import { describe, expect, it } from "vitest";
import {
  SES_FIXTURE_API,
  SES_FIXTURE_CERT_URL,
  SES_FIXTURE_MESSAGE_ID,
  SES_FIXTURE_SNS_ID,
  SES_FIXTURE_TOPIC,
  sesFixture,
  sesFixtureSigner,
  sesNotification,
  signSesWebhook,
  snsEnvelope,
} from "../../src/conformance/fixtures/ses";
import { type CapturedRequest, mockFetch, runChecks } from "../../src/conformance/index";
import type { SendContext, WebhookVerifyInput } from "../../src/core/adapter";
import type { OutgoingMessage, SendResult } from "../../src/core/types";
import { createMailer } from "../../src/index";
import { bytesToBase64, bytesToHex, utf8 } from "../../src/internal/encoding";
import type { FetchLike } from "../../src/internal/http";
import { amzDate, canonicalRequest, signingKey } from "../../src/internal/sigv4";
import { type SnsMessage, ses, snsConfirmAction } from "../../src/providers/ses/index";
import { isSnsCertUrl, parseTopicArn } from "../../src/providers/ses/sns-verify";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const SEND_URL = `${SES_FIXTURE_API}/v2/email/outbound-emails`;
const CREDENTIALS = sesFixture().credentials;
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

function ctx(fetch: FetchLike, extra: Record<string, string> = {}): SendContext {
  return { fetch, timeoutMs: 1000, credentials: { ...CREDENTIALS, ...extra }, now: NOW };
}

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { email: "billing@example.com", name: "Zoë from Acme" },
    to: ["ana@example.org"],
    subject: "Invoice 42",
    html: "<p>Your invoice is attached.</p>",
    text: "Your invoice is attached.",
    ...overrides,
  };
}

function sendMock(status: number, body: unknown, headers: Record<string, string> = {}) {
  return mockFetch([
    { label: "send", method: "POST", url: SEND_URL, response: { status, body, headers } },
  ]);
}

const decoder = new TextDecoder();

describe("ses send", () => {
  it("posts Content.Simple with attachments and a SigV4 signature", async () => {
    const mock = sendMock(200, { MessageId: SES_FIXTURE_MESSAGE_ID });
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const result = await ses({ configurationSetName: "events" }).send(
      message({
        cc: ["cc@example.org"],
        bcc: ["bcc@example.org"],
        replyTo: "help@example.com",
        headers: { "X-Entity-Ref": "inv-42" },
        attachments: [
          { filename: "invoice.pdf", content: pdf, contentType: "application/pdf" },
          {
            filename: "logo.png",
            content: "iVBORw==",
            contentType: "image/png",
            contentId: "logo",
          },
        ],
      }),
      ctx(mock.fetch, { sessionToken: "session-token-1" }),
    );
    expect(result).toEqual({
      status: "sent",
      provider: "ses",
      providerMessageId: SES_FIXTURE_MESSAGE_ID,
    });
    const request = mock.calls[0] as CapturedRequest;
    expect(JSON.parse(request.body)).toEqual({
      FromEmailAddress: "=?UTF-8?B?Wm/DqyBmcm9tIEFjbWU=?= <billing@example.com>",
      Destination: {
        ToAddresses: ["ana@example.org"],
        CcAddresses: ["cc@example.org"],
        BccAddresses: ["bcc@example.org"],
      },
      ReplyToAddresses: ["help@example.com"],
      ConfigurationSetName: "events",
      Content: {
        Simple: {
          Subject: { Data: "Invoice 42", Charset: "UTF-8" },
          Body: {
            Html: { Data: "<p>Your invoice is attached.</p>", Charset: "UTF-8" },
            Text: { Data: "Your invoice is attached.", Charset: "UTF-8" },
          },
          Headers: [{ Name: "X-Entity-Ref", Value: "inv-42" }],
          Attachments: [
            {
              FileName: "invoice.pdf",
              RawContent: bytesToBase64(pdf),
              ContentType: "application/pdf",
              ContentTransferEncoding: "BASE64",
              ContentDisposition: "ATTACHMENT",
            },
            {
              FileName: "logo.png",
              RawContent: "iVBORw==",
              ContentType: "image/png",
              ContentTransferEncoding: "BASE64",
              ContentDisposition: "INLINE",
              ContentId: "logo",
            },
          ],
        },
      },
    });
    expect(request.headers.get("x-amz-date")).toBe(amzDate(NOW));
    expect(request.headers.get("x-amz-security-token")).toBe("session-token-1");
    expect(request.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261026\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
  });

  it("signs a request that the SigV4 canonical form reproduces", async () => {
    const mock = sendMock(200, { MessageId: "id" });
    await ses().send(message(), ctx(mock.fetch));
    const request = mock.calls[0] as CapturedRequest;
    const signed = await canonicalRequest(
      {
        method: "POST",
        url: request.url,
        headers: { "content-type": "application/json" },
        body: request.body,
      },
      NOW,
    );
    const key = await signingKey(SECRET, "20261026", { region: "us-east-1", service: "ses" });
    const scope = "20261026/us-east-1/ses/aws4_request";
    const hash = bytesToHex(await crypto.subtle.digest("SHA-256", utf8(signed.text)));
    const imported = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = bytesToHex(
      await crypto.subtle.sign(
        "HMAC",
        imported,
        utf8(`AWS4-HMAC-SHA256\n${amzDate(NOW)}\n${scope}\n${hash}`),
      ),
    );
    expect(request.headers.get("authorization")).toContain(`Signature=${signature}`);
  });

  it.each([
    [400, "MessageRejected", "Email address is not verified.", "not_sent", "rejected"],
    [400, "LimitExceededException", "Limit exceeded.", "not_sent", "quota"],
    [400, "ThrottlingException", "Daily message quota exceeded.", "not_sent", "quota"],
    [429, "TooManyRequestsException", "Maximum sending rate exceeded.", "not_sent", "rate_limited"],
    [403, "ExpiredTokenException", "The security token is expired.", "not_sent", "auth"],
    [400, "AccountSuspendedException", "Suspended.", "not_sent", "auth"],
    [400, "MailFromDomainNotVerifiedException", "Not verified.", "not_sent", "rejected"],
    [404, "NotFoundException", "Configuration set does not exist.", "not_sent", "invalid_message"],
    [500, "InternalFailure", "Internal error.", "unknown", "provider_error"],
    [503, "ServiceUnavailable", "Unavailable.", "unknown", "provider_error"],
  ])("maps HTTP %i %s to the right status", async (status, type, text, want, reason) => {
    const mock = sendMock(status, { message: text }, { "x-amzn-errortype": `${type}:http://x` });
    const result = await ses().send(message(), ctx(mock.fetch));
    expect(result.status).toBe(want);
    expect(result).toMatchObject({ reason, provider: "ses", httpStatus: status });
    expect(JSON.stringify(result)).not.toContain(text);
  });

  it("refuses more than 15 custom headers with no request", async () => {
    const mock = sendMock(200, {});
    const headers = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`X-Custom-${i}`, "1"]),
    );
    const result = await ses().send(message({ headers }), ctx(mock.fetch));
    expect(result).toMatchObject({ status: "not_sent", reason: "unsupported" });
    expect(mock.calls).toHaveLength(0);
  });

  it("uses the endpoint option and the China host suffix", async () => {
    const mock = mockFetch([
      {
        label: "proxy",
        method: "POST",
        url: "https://ses.proxy.example/v2/email/outbound-emails",
        response: { status: 200, body: { MessageId: "x" } },
      },
    ]);
    const result = await ses({ endpoint: "https://ses.proxy.example/" }).send(
      message(),
      ctx(mock.fetch),
    );
    expect(result.status).toBe("sent");
    expect(() => ses({ endpoint: "not a url" })).toThrow(TypeError);
  });

  it("keeps the canonical request and the signing key out of results and hooks", async () => {
    const secretKey = "wJalrXUtnFEMI/K7MDENG/cnrySECRETcanaryKEY";
    const captured: CapturedRequest[] = [];
    const responses: (number | "network")[] = [403, 400, 429, 500, "network"];
    const outputs: unknown[] = [];
    for (const response of responses) {
      const mock = mockFetch([
        {
          label: "send",
          method: "POST",
          url: SEND_URL,
          response:
            response === "network" ? "network" : { status: response, body: { message: "bad" } },
        },
      ]);
      const views: unknown[] = [];
      const logs: unknown[] = [];
      const mailer = createMailer({
        providers: [
          {
            adapter: ses(),
            credentials: { ...CREDENTIALS, secretAccessKey: secretKey, sessionToken: "tok-cnry" },
          },
        ],
        fetch: mock.fetch,
        now: () => NOW,
        onAttempt: (view) => {
          views.push(view);
        },
        logger: { warn: (text, data) => logs.push(text, data) },
      });
      const result: SendResult = await mailer.send(message());
      outputs.push(result, views, logs);
      captured.push(...mock.calls);
    }
    const text = JSON.stringify(outputs);
    expect(captured.length).toBe(responses.length);
    const key = bytesToHex(
      await signingKey(secretKey, "20261026", { region: "us-east-1", service: "ses" }),
    );
    for (const request of captured) {
      const canonical = await canonicalRequest(
        {
          method: "POST",
          url: request.url,
          headers: { "content-type": "application/json" },
          body: request.body,
        },
        NOW,
        "tok-cnry",
      );
      expect(text).not.toContain(canonical.text);
      expect(text).not.toContain(canonical.text.split("\n").at(-1));
      const signature = /Signature=([0-9a-f]+)/.exec(request.headers.get("authorization") ?? "");
      expect(text).not.toContain(signature?.[1]);
    }
    expect(text).not.toContain(key);
    expect(text).not.toContain(secretKey);
    expect(text).not.toContain("tok-cnry");
    expect(text).not.toContain("AWS4-HMAC-SHA256");
  });
});

describe("ses verify", () => {
  it("calls GetAccount and maps a bad key to auth", async () => {
    const fixture = sesFixture();
    const good = mockFetch(fixture.verify.ok);
    expect(await ses().verify(ctx(good.fetch))).toEqual({ ok: true });
    expect(good.calls[0]?.method).toBe("GET");
    const bad = mockFetch(fixture.verify.badKey);
    expect(await ses().verify(ctx(bad.fetch))).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
  });
});

// SNS webhooks.

interface FetchLog {
  fetch: FetchLike;
  urls: string[];
  inits: RequestInit[];
}

/** Serves the test certificate. Counts each fetch. */
async function certFetch(
  respond?: (url: string, count: number) => Response | Promise<Response>,
): Promise<FetchLog> {
  const signer = await sesFixtureSigner();
  const log: FetchLog = {
    urls: [],
    inits: [],
    fetch: async (url, init) => {
      log.urls.push(url);
      log.inits.push(init);
      if (respond) return respond(url, log.urls.length);
      if (url.endsWith(".pem")) return new Response(signer.certificatePem, { status: 200 });
      return new Response("not found", { status: 404 });
    },
  };
  return log;
}

function bounce(snsId = SES_FIXTURE_SNS_ID): Uint8Array {
  return utf8(
    sesNotification(
      {
        eventType: "Bounce",
        bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@example.org" }] },
      },
      snsId,
    ),
  );
}

async function signed(
  overrides: { at?: number; topic?: string; certUrl?: string; version?: "1" | "2" } = {},
) {
  return signSesWebhook({
    body: bounce(),
    secret: overrides.topic ?? SES_FIXTURE_TOPIC,
    at: overrides.at ?? NOW,
    ...(overrides.certUrl ? { certUrl: overrides.certUrl } : {}),
    ...(overrides.version ? { version: overrides.version } : {}),
  });
}

function input(
  sample: { headers: Headers; body: Uint8Array },
  fetch: FetchLike,
  secret = SES_FIXTURE_TOPIC,
  now = NOW,
): WebhookVerifyInput {
  return { headers: sample.headers, body: sample.body, secret, now, fetch };
}

describe("ses SNS verification", () => {
  it("accepts a valid signature of version 2 and version 1", async () => {
    const log = await certFetch();
    const verify = ses().webhooks?.verify;
    expect(await verify?.(input(await signed(), log.fetch))).toEqual({ ok: true });
    expect(await verify?.(input(await signed({ version: "1" }), log.fetch))).toEqual({ ok: true });
    expect(log.urls).toEqual([SES_FIXTURE_CERT_URL]);
    expect(log.inits[0]?.redirect).toBe("manual");
    expect(log.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses version 1 with requireSignatureVersion2", async () => {
    const log = await certFetch();
    const verify = ses({ requireSignatureVersion2: true }).webhooks?.verify;
    expect(await verify?.(input(await signed({ version: "1" }), log.fetch))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(log.urls).toEqual([]);
  });

  it("refuses a valid signature from a topic that is not on the allowlist, with no fetch", async () => {
    const log = await certFetch();
    const verify = ses().webhooks?.verify;
    const other = "arn:aws:sns:us-east-1:999999999999:attacker-topic";
    const sample = await signed({ topic: other });
    expect(await verify?.(input(sample, log.fetch))).toEqual({
      ok: false,
      reason: "untrusted_topic",
    });
    expect(await verify?.(input(sample, log.fetch, ""))).toEqual({
      ok: false,
      reason: "untrusted_topic",
    });
    // The same message passes when its topic is on a list of two.
    expect(await verify?.(input(sample, log.fetch, `${SES_FIXTURE_TOPIC}, ${other}`))).toEqual({
      ok: true,
    });
    expect(log.urls).toHaveLength(1);
  });

  it("refuses a stale or a future Timestamp, with no fetch", async () => {
    const log = await certFetch();
    const verify = ses().webhooks?.verify;
    const old = await signed({ at: NOW - 60 * 60 * 1000 - 1000 });
    expect(await verify?.(input(old, log.fetch))).toEqual({ ok: false, reason: "stale" });
    const future = await signed({ at: NOW + 10 * 60 * 1000 });
    expect(await verify?.(input(future, log.fetch))).toEqual({ ok: false, reason: "stale" });
    expect(log.urls).toEqual([]);
    // The window is configurable.
    const strict = ses({ snsMaxAgeMs: 60_000 }).webhooks?.verify;
    const twoMinutes = await signed({ at: NOW - 120_000 });
    expect(await strict?.(input(twoMinutes, log.fetch))).toEqual({ ok: false, reason: "stale" });
    expect(await verify?.(input(twoMinutes, log.fetch))).toEqual({ ok: true });
  });

  it.each([
    [
      "a look-alike host",
      "https://sns.us-east-1.amazonaws.com.evil.example/SimpleNotificationService-abc.pem",
    ],
    ["another region", "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem"],
    ["plain http", "http://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem"],
    ["a port", "https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-abc.pem"],
    ["user info", "https://user@sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem"],
    ["a path that is not a certificate", "https://sns.us-east-1.amazonaws.com/cert.txt"],
    ["a query", "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem?x=1"],
    ["another host", "https://evil.example/SimpleNotificationService-abc.pem"],
  ])("refuses a certificate URL with %s, with no fetch", async (_, certUrl) => {
    const log = await certFetch();
    const result = await ses().webhooks?.verify(input(await signed({ certUrl }), log.fetch));
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
    expect(log.urls).toEqual([]);
  });

  it("accepts the China host for a cn- topic", () => {
    const topic = parseTopicArn("arn:aws-cn:sns:cn-north-1:123456789012:events");
    expect(topic).not.toBeNull();
    if (!topic) return;
    expect(
      isSnsCertUrl(
        "https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-abc.pem",
        topic,
      ),
    ).toBe(true);
    expect(
      isSnsCertUrl("https://sns.cn-north-1.amazonaws.com/SimpleNotificationService-abc.pem", topic),
    ).toBe(false);
  });

  it("refuses a certificate URL that redirects", async () => {
    const log = await certFetch(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://evil.example/cert.pem" },
        }),
    );
    const verify = ses().webhooks?.verify;
    expect(await verify?.(input(await signed(), log.fetch))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(log.urls).toEqual([SES_FIXTURE_CERT_URL]);
    expect(log.inits[0]?.redirect).not.toBe("follow");
    // A response that a fetch reached through a redirect is refused too.
    const signer = await sesFixtureSigner();
    const followed = await certFetch(() => {
      const response = new Response(signer.certificatePem, { status: 200 });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    expect(await verify?.(input(await signed(), followed.fetch))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a certificate over the size cap and does not cache a failure", async () => {
    const signer = await sesFixtureSigner();
    const verify = ses({ maxCertBytes: 100 }).webhooks?.verify;
    const big = await certFetch(() => new Response(signer.certificatePem, { status: 200 }));
    expect(await verify?.(input(await signed(), big.fetch))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const flaky = await certFetch((_, count) =>
      count === 1
        ? new Response("busy", { status: 503 })
        : new Response(signer.certificatePem, { status: 200 }),
    );
    const normal = ses().webhooks?.verify;
    expect(await normal?.(input(await signed(), flaky.fetch))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await normal?.(input(await signed(), flaky.fetch))).toEqual({ ok: true });
    expect(await normal?.(input(await signed(), flaky.fetch))).toEqual({ ok: true });
    expect(flaky.urls).toHaveLength(2);
  });

  it("caches a certificate for 24 hours", async () => {
    const log = await certFetch();
    const verify = ses({ snsMaxAgeMs: 48 * 60 * 60 * 1000 }).webhooks?.verify;
    const sample = await signed();
    expect(await verify?.(input(sample, log.fetch))).toEqual({ ok: true });
    expect(
      await verify?.(input(sample, log.fetch, SES_FIXTURE_TOPIC, NOW + 23 * 3600_000)),
    ).toEqual({ ok: true });
    expect(log.urls).toHaveLength(1);
    expect(
      await verify?.(input(sample, log.fetch, SES_FIXTURE_TOPIC, NOW + 25 * 3600_000)),
    ).toEqual({ ok: true });
    expect(log.urls).toHaveLength(2);
  });

  it("makes at most one certificate fetch for 100 forged requests from an allowlisted topic", async () => {
    const log = await certFetch();
    const verify = ses().webhooks?.verify;
    const forged = async (index: number) => {
      const base = JSON.parse(decoder.decode((await signed()).body)) as SnsMessage;
      const fake = bytesToBase64(crypto.getRandomValues(new Uint8Array(256)));
      const body = utf8(JSON.stringify({ ...base, MessageId: `forged-${index}`, Signature: fake }));
      return verify?.(
        input(
          { headers: new Headers({ "x-amz-sns-message-type": "Notification" }), body },
          log.fetch,
        ),
      );
    };
    const first = await Promise.all(Array.from({ length: 50 }, (_, i) => forged(i)));
    const rest: unknown[] = [];
    for (let i = 50; i < 100; i++) rest.push(await forged(i));
    for (const result of [...first, ...rest]) {
      expect(result).toEqual({ ok: false, reason: "bad_signature" });
    }
    expect(log.urls.length).toBeLessThanOrEqual(1);
  });

  it("refuses a changed field, a missing type header, and a broken body", async () => {
    const log = await certFetch();
    const verify = ses().webhooks?.verify;
    const sample = await signed();
    const value = JSON.parse(decoder.decode(sample.body)) as SnsMessage;
    const changed = utf8(JSON.stringify({ ...value, MessageId: "other" }));
    expect(
      await verify?.(
        input(
          { headers: new Headers({ "x-amz-sns-message-type": "Notification" }), body: changed },
          log.fetch,
        ),
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify?.(input({ headers: new Headers(), body: sample.body }, log.fetch))).toEqual(
      { ok: false, reason: "malformed" },
    );
    expect(
      await verify?.(
        input({ headers: sample.headers, body: new Uint8Array([0xff, 0xfe]) }, log.fetch),
      ),
    ).toEqual({ ok: false, reason: "malformed" });
    const unknownVersion = utf8(JSON.stringify({ ...value, SignatureVersion: "3" }));
    expect(
      await verify?.(input({ headers: sample.headers, body: unknownVersion }, log.fetch)),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("ses SubscriptionConfirmation", () => {
  const confirmation = () =>
    utf8(
      snsEnvelope({
        Type: "SubscriptionConfirmation",
        MessageId: "confirm-1",
        Token: "token-1",
        Message: "You have chosen to subscribe.",
        SubscribeURL:
          "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=token-1",
      }),
    );

  it("never fetches SubscribeURL and returns a confirm action", async () => {
    const log = await certFetch();
    const sample = await signSesWebhook({
      body: confirmation(),
      secret: SES_FIXTURE_TOPIC,
      at: NOW,
    });
    const request = new Request("https://app.example/webhooks/ses", {
      method: "POST",
      headers: sample.headers,
      body: sample.body,
    });
    const adapter = ses();
    const hooks = adapter.webhooks;
    expect(await hooks?.verify(input(sample, log.fetch))).toEqual({ ok: true });
    const outcome = await handleWebhook(request, {
      adapter,
      secret: SES_FIXTURE_TOPIC,
      now: () => NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [event] = outcome.events;
    expect(event).toMatchObject({ type: "unknown", rawType: "SubscriptionConfirmation" });
    expect(event && snsConfirmAction(event)).toEqual({
      type: "confirm_subscription",
      topicArn: SES_FIXTURE_TOPIC,
      subscribeUrl:
        "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=token-1",
    });
    expect(log.urls.every((url) => url === SES_FIXTURE_CERT_URL)).toBe(true);
  });

  it("refuses a confirmation from a topic that is not on the allowlist", async () => {
    const log = await certFetch();
    const other = "arn:aws:sns:us-east-1:999999999999:attacker";
    const sample = await signSesWebhook({ body: confirmation(), secret: other, at: NOW });
    expect(await ses().webhooks?.verify(input(sample, log.fetch))).toEqual({
      ok: false,
      reason: "untrusted_topic",
    });
    expect(log.urls).toEqual([]);
  });

  it("gives no action for a SubscribeURL off the SNS host", () => {
    const body = utf8(
      JSON.stringify({
        ...JSON.parse(decoder.decode(confirmation())),
        Timestamp: new Date(NOW).toISOString(),
        Signature: "x",
        SignatureVersion: "2",
        SigningCertURL: SES_FIXTURE_CERT_URL,
        SubscribeURL: "https://evil.example/?Action=ConfirmSubscription",
      }),
    );
    const [event] = ses().webhooks?.parse(body, new Headers()) ?? [];
    expect(event && snsConfirmAction(event)).toBeNull();
  });
});

describe("ses events through handleWebhook", () => {
  it("gives the documented normalized events and drops a replay", async () => {
    const fixture = sesFixture();
    const webhook = fixture.webhook;
    if (!webhook) throw new Error("The fixture has no webhook part.");
    const signer = await sesFixtureSigner();
    const fetchCert: FetchLike = async () => new Response(signer.certificatePem, { status: 200 });
    const globalFetch = globalThis.fetch;
    globalThis.fetch = fetchCert as typeof fetch;
    try {
      const adapter = ses();
      const dedupe = new MemoryDedupeStore();
      for (const sample of webhook.samples) {
        const body = typeof sample.body === "string" ? utf8(sample.body) : sample.body;
        const signedSample = await webhook.sign({ body, secret: webhook.secret, at: NOW });
        const request = () =>
          new Request("https://app.example/webhooks/ses", {
            method: "POST",
            headers: signedSample.headers,
            body: signedSample.body,
          });
        const outcome = await handleWebhook(request(), {
          adapter,
          secret: webhook.secret,
          dedupe,
          now: () => NOW,
        });
        expect(outcome.ok, sample.label).toBe(true);
        if (!outcome.ok) continue;
        expect(outcome.events).toHaveLength(sample.expected.length);
        sample.expected.forEach((want, index) => {
          expect(outcome.events[index], sample.label).toMatchObject(want);
        });
        await outcome.ack();
        const replay = await handleWebhook(request(), {
          adapter,
          secret: webhook.secret,
          dedupe,
          now: () => NOW,
        });
        expect(replay.ok && replay.events).toEqual([]);
      }
    } finally {
      globalThis.fetch = globalFetch;
    }
  });

  it("refuses an untrusted topic through handleWebhook with 401", async () => {
    const sample = await signSesWebhook({
      body: bounce(),
      secret: "arn:aws:sns:us-east-1:999999999999:attacker",
      at: NOW,
    });
    const outcome = await handleWebhook(
      new Request("https://app.example/", {
        method: "POST",
        headers: sample.headers,
        body: sample.body,
      }),
      { adapter: ses(), secret: SES_FIXTURE_TOPIC, now: () => NOW },
    );
    expect(outcome).toEqual({ ok: false, rejection: "untrusted_topic", status: 401 });
  });

  it("parses a notification with a body that is not SES JSON as one unknown event", () => {
    const body = utf8(
      JSON.stringify({
        ...JSON.parse(snsEnvelope({ Message: "plain text" })),
        Timestamp: "2026-10-26T12:00:00.000Z",
        Signature: "x",
        SigningCertURL: SES_FIXTURE_CERT_URL,
      }),
    );
    expect(ses().webhooks?.parse(body, new Headers())).toEqual([
      {
        provider: "ses",
        eventKey: SES_FIXTURE_SNS_ID,
        type: "unknown",
        rawType: "Notification",
        occurredAt: Date.parse("2026-10-26T12:00:00.000Z"),
      },
    ]);
    expect(ses().webhooks?.parse(utf8("not json"), new Headers())).toEqual([]);
  });
});

describe("ses conformance report", () => {
  it("passes every check that applies", async () => {
    const report = await runChecks({ adapter: ses(), fixture: sesFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(
      report.checks.filter((entry) => entry.status === "n/a").map((entry) => entry.id),
    ).toEqual(["send.idempotency", "idempotency.conflict", "send.batch"]);
  });
});
