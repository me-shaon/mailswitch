import { describe, expect, it } from "vitest";
import {
  MAILCHANNELS_FIXTURE_OTHER_PUBLIC_KEY,
  MAILCHANNELS_FIXTURE_PUBLIC_KEY,
  type MailchannelsSignOptions,
  mailchannelsAccepted,
  mailchannelsEvent,
  signMailchannelsWebhook,
} from "../../src/conformance/fixtures/mailchannels";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  MAILCHANNELS_API_BASE,
  MAILCHANNELS_DIGEST_HEADER,
  MAILCHANNELS_SIGNATURE_HEADER,
  MAILCHANNELS_SIGNATURE_INPUT_HEADER,
  mailchannels,
  mailchannelsContentDigest,
} from "../../src/providers/mailchannels/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = `${MAILCHANNELS_API_BASE}/tx/v1/send`;
const USAGE_URL = `${MAILCHANNELS_API_BASE}/tx/v1/usage`;
const KEY = "test-mailchannels-key-not-real";
const PUBLIC_KEY = MAILCHANNELS_FIXTURE_PUBLIC_KEY;
const NOW = Date.parse("2026-10-27T12:00:30.000Z");

function context(exchanges: RecordedExchange[], credentials: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = {
    fetch: mock.fetch,
    timeoutMs: 5_000,
    credentials: { apiKey: KEY, ...credentials },
    now: NOW,
  };
  return { mock, ctx };
}

function exchange(
  url: string,
  status: number,
  body: unknown = "",
  method = "POST",
  headers: Record<string, string> = {},
): RecordedExchange {
  return { label: `${method} ${url} ${status}`, method, url, response: { status, headers, body } };
}

function accepted(results?: Parameters<typeof mailchannelsAccepted>[0]): RecordedExchange {
  return exchange(SEND_URL, 202, mailchannelsAccepted(results));
}

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: "Acme Billing <billing@example.com>",
    to: ["ana@example.org"],
    subject: "Your invoice",
    html: "<p>Invoice attached.</p>",
    text: "Invoice attached.",
    ...overrides,
  };
}

describe("mailchannels send", () => {
  it("maps a full message to the documented payload and returns sent", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([accepted([{ status: "sent", message_id: "mc-1" }])]);
    const result = await mailchannels().send(
      message({
        to: ["ana@example.org", { email: "bo@example.org", name: "Bo, Jr." }],
        cc: [{ email: "cc@example.org", name: "Cy" }],
        bcc: ["bcc@example.org"],
        replyTo: "Support <support@example.com>",
        headers: { "X-Invoice": "INV-1" },
        attachments: [
          { filename: "invoice.pdf", content: pdf, contentType: "application/pdf" },
          {
            filename: "logo.png",
            content: bytesToBase64(utf8("png")),
            contentType: "image/png",
            contentId: "logo",
          },
        ],
      }),
      ctx,
    );
    expect(result).toEqual({ status: "sent", provider: "mailchannels", providerMessageId: "mc-1" });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("x-api-key")).toBe(KEY);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.has("authorization")).toBe(false);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      personalizations: [
        {
          to: [{ email: "ana@example.org" }, { email: "bo@example.org", name: "Bo, Jr." }],
          cc: [{ email: "cc@example.org", name: "Cy" }],
          bcc: [{ email: "bcc@example.org" }],
        },
      ],
      from: { email: "billing@example.com", name: "Acme Billing" },
      reply_to: { email: "support@example.com", name: "Support" },
      subject: "Your invoice",
      content: [
        { type: "text/plain", value: "Invoice attached." },
        { type: "text/html", value: "<p>Invoice attached.</p>" },
      ],
      headers: { "X-Invoice": "INV-1" },
      attachments: [
        { content: bytesToBase64(pdf), filename: "invoice.pdf", type: "application/pdf" },
        {
          content: bytesToBase64(utf8("png")),
          filename: "logo.png",
          type: "image/png",
          content_id: "logo",
        },
      ],
    });
  });

  it("sends only the parts that the message has, and no idempotency key", async () => {
    const { mock, ctx } = context([accepted()]);
    await mailchannels().send(message({ html: undefined, idempotencyKey: "invoice-1" }), ctx);
    const body = JSON.parse(mock.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.content).toEqual([{ type: "text/plain", value: "Invoice attached." }]);
    expect(body.personalizations).toEqual([{ to: [{ email: "ana@example.org" }] }]);
    expect(body).not.toHaveProperty("reply_to");
    expect(body).not.toHaveProperty("headers");
    expect(body).not.toHaveProperty("attachments");
    expect(mock.calls[0]?.url).toBe(SEND_URL);
    expect(mock.calls[0]?.body).not.toContain("invoice-1");
    expect([...(mock.calls[0]?.headers.values() ?? [])]).not.toContain("invoice-1");
  });

  it("takes the id of the first sent entry, at any index", async () => {
    const { ctx } = context([
      accepted([
        { status: "failed", reason: "blocked" },
        { status: "sent", message_id: "mc-2" },
        { status: "sent", message_id: "mc-3" },
      ]),
    ]);
    expect(await mailchannels().send(message(), ctx)).toEqual({
      status: "sent",
      provider: "mailchannels",
      providerMessageId: "mc-2",
    });
  });

  it("gives sent with no id when the sent entry has no message_id", async () => {
    const { ctx } = context([accepted([{ status: "sent" }])]);
    expect(await mailchannels().send(message(), ctx)).toEqual({
      status: "sent",
      provider: "mailchannels",
    });
  });

  it("keeps a 202 with no sent entry unknown", async () => {
    const cases: unknown[] = [
      mailchannelsAccepted([{ status: "failed", reason: "rejected" }]),
      mailchannelsAccepted([
        { status: "failed", reason: "a" },
        { status: "failed", reason: "b" },
      ]),
      mailchannelsAccepted([]),
      mailchannelsAccepted([{ status: "queued", message_id: "mc-4" }]),
      { request_id: "mc-request-0001" },
      { results: "sent" },
      ["sent"],
      "not json",
      "",
    ];
    for (const body of cases) {
      const { ctx } = context([exchange(SEND_URL, 202, body)]);
      const result = await mailchannels().send(message(), ctx);
      expect(result).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        provider: "mailchannels",
      });
      expect(result).not.toHaveProperty("providerMessageId");
    }
  });

  it("maps 400, 401, 403, and 413 and keeps the body out of the result", async () => {
    const cases: [number, string][] = [
      [400, "invalid_message"],
      [401, "auth"],
      [403, "auth"],
      [413, "invalid_message"],
    ];
    for (const [status, reason] of cases) {
      const { ctx } = context([exchange(SEND_URL, status, { errors: ["secret-ish body text"] })]);
      const result = await mailchannels().send(message(), ctx);
      expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: status });
      expect(result.provider).toBe("mailchannels");
      expect(JSON.stringify(result)).not.toContain("secret-ish");
    }
  });

  it("maps a 429 to rate_limited with Retry-After", async () => {
    const { ctx } = context([exchange(SEND_URL, 429, "", "POST", { "retry-after": "7" })]);
    expect(await mailchannels().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 7000,
    });
  });

  it("keeps a 500, a 502, a timeout, and a network error unknown", async () => {
    for (const status of [500, 502, 503]) {
      const { ctx } = context([exchange(SEND_URL, status)]);
      expect(await mailchannels().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
      });
    }
    const slow = context([
      { label: "timeout", method: "POST", url: SEND_URL, response: "timeout" },
    ]);
    expect(await mailchannels().send(message(), slow.ctx)).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
    const down = context([
      { label: "network", method: "POST", url: SEND_URL, response: "network" },
    ]);
    expect(await mailchannels().send(message(), down.ctx)).toMatchObject({
      status: "unknown",
      reason: "network",
    });
  });

  it("refuses a reserved header before any request", async () => {
    const cases: Record<string, string>[] = [
      { "Message-ID": "<a@example.com>" },
      { Received: "from x" },
      { "Authentication-Results": "pass" },
    ];
    for (const headers of cases) {
      const { mock, ctx } = context([accepted()]);
      const result = await mailchannels().send(message({ headers }), ctx);
      expect(result).toMatchObject({
        status: "not_sent",
        reason: "invalid_message",
        provider: "mailchannels",
      });
      expect(JSON.stringify(result)).not.toContain("from x");
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("refuses custom headers over 5 KB before any request", async () => {
    const { mock, ctx } = context([accepted()]);
    const headers = { "X-Big-1": "a".repeat(2600), "X-Big-2": "b".repeat(2600) };
    expect(await mailchannels().send(message({ headers }), ctx)).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
    });
    expect(mock.calls).toHaveLength(0);
    const fits = context([accepted()]);
    await mailchannels().send(message({ headers: { "X-Fits": "a".repeat(4900) } }), fits.ctx);
    expect(fits.mock.calls).toHaveLength(1);
  });

  it("refuses more than 1000 recipients before any request", async () => {
    const { mock, ctx } = context([accepted()]);
    const to = Array.from({ length: 1001 }, (_, index) => `r${index}@example.org`);
    expect(await mailchannels().send(message({ to }), ctx)).toMatchObject({ status: "not_sent" });
    expect(mock.calls).toHaveLength(0);
  });

  it("adds dry-run=true in dry-run mode and reads the 200 answer as sent", async () => {
    const url = `${SEND_URL}?dry-run=true`;
    const { mock, ctx } = context([exchange(url, 200, { data: ["From: ..."] })]);
    expect(await mailchannels({ dryRun: true }).send(message(), ctx)).toEqual({
      status: "sent",
      provider: "mailchannels",
    });
    expect(mock.calls[0]?.url).toBe(url);
    const empty = context([exchange(url, 200, { data: [] })]);
    expect(await mailchannels({ dryRun: true }).send(message(), empty.ctx)).toMatchObject({
      status: "unknown",
    });
    // Without dry-run mode, a data answer is not a send result.
    const plain = context([exchange(SEND_URL, 200, { data: ["From: ..."] })]);
    expect(await mailchannels().send(message(), plain.ctx)).toMatchObject({ status: "unknown" });
  });

  it("sends to baseUrl and uses the option key", async () => {
    const mock = mockFetch([
      exchange("http://localhost:8787/tx/v1/send", 202, mailchannelsAccepted()),
    ]);
    const ctx: SendContext = { fetch: mock.fetch, timeoutMs: 5_000, credentials: {}, now: NOW };
    const adapter = mailchannels({ baseUrl: "http://localhost:8787/", apiKey: KEY });
    expect(await adapter.send(message(), ctx)).toMatchObject({ status: "sent" });
    expect(mock.calls[0]?.headers.get("x-api-key")).toBe(KEY);
  });

  it("throws a TypeError for invalid options", () => {
    expect(() => mailchannels({ baseUrl: "http://api.mailchannels.net" })).toThrow(TypeError);
    expect(() => mailchannels({ baseUrl: "https://key@api.mailchannels.net" })).toThrow(TypeError);
    expect(() => mailchannels({ dryRun: "yes" as unknown as boolean })).toThrow(TypeError);
    expect(() => mailchannels({ apiKey: 42 as unknown as string })).toThrow(
      new TypeError("mailchannels: apiKey must be a string."),
    );
    expect(() => mailchannels(null as unknown as object)).toThrow(TypeError);
  });
});

describe("mailchannels verify", () => {
  it("is ok for a 200 from the usage call", async () => {
    const { mock, ctx } = context([exchange(USAGE_URL, 200, { usage: 1 }, "GET")]);
    expect(await mailchannels().verify(ctx)).toEqual({ ok: true });
    expect(mock.calls[0]?.method).toBe("GET");
    expect(mock.calls[0]?.headers.get("x-api-key")).toBe(KEY);
  });

  it("is not_sent/auth for a 401 and a 403", async () => {
    for (const status of [401, 403]) {
      const { ctx } = context([exchange(USAGE_URL, status, "", "GET")]);
      expect(await mailchannels().verify(ctx)).toMatchObject({
        ok: false,
        status: "not_sent",
        reason: "auth",
        provider: "mailchannels",
      });
    }
  });

  it("is unknown for a 5xx and a network error", async () => {
    const down = context([exchange(USAGE_URL, 500, "", "GET")]);
    expect(await mailchannels().verify(down.ctx)).toMatchObject({ ok: false, status: "unknown" });
    const lost = context([
      { label: "network", method: "GET", url: USAGE_URL, response: "network" },
    ]);
    expect(await mailchannels().verify(lost.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });
});

const THREE_EVENTS = JSON.stringify([
  mailchannelsEvent("delivered"),
  mailchannelsEvent("soft-bounced", { timestamp: 1793102350 }),
  mailchannelsEvent("hard-bounced", { recipients: ["bo@example.org"] }),
]);

async function signed(body: string, at = NOW, options?: MailchannelsSignOptions) {
  return signMailchannelsWebhook({ body: utf8(body), secret: PUBLIC_KEY, at }, options);
}

describe("mailchannels webhooks", () => {
  const hooks = mailchannels().webhooks;

  function input(sample: { headers: Headers; body: Uint8Array }, secret = PUBLIC_KEY) {
    return { headers: sample.headers, body: sample.body, secret, now: NOW };
  }

  function withHeader(sample: { headers: Headers; body: Uint8Array }, name: string, value: string) {
    const headers = new Headers(sample.headers);
    headers.set(name, value);
    return { headers, body: sample.body };
  }

  it("accepts a signed array of three events and gives three distinct keys", async () => {
    const sample = await signed(THREE_EVENTS);
    expect(await hooks.verify(input(sample))).toEqual({ ok: true });
    const events = hooks.parse(sample.body, sample.headers);
    expect(events.map((event) => [event.type, event.bounce, event.rawType])).toEqual([
      ["delivered", undefined, "delivered"],
      ["bounced", "soft", "soft-bounced"],
      ["bounced", "hard", "hard-bounced"],
    ]);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(3);
    expect(events[2]).toMatchObject({
      provider: "mailchannels",
      recipient: "bo@example.org",
      occurredAt: 1793102340000,
    });
    expect(events[0]).not.toHaveProperty("providerMessageId");
  });

  it("accepts a key in PEM form", async () => {
    const pem = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY}\n-----END PUBLIC KEY-----\n`;
    expect(await hooks.verify(input(await signed(THREE_EVENTS), pem))).toEqual({ ok: true });
  });

  it("refuses a changed body and a wrong key", async () => {
    const sample = await signed(THREE_EVENTS);
    const changed = { headers: sample.headers, body: utf8(THREE_EVENTS.replace("ana", "eve")) };
    expect(await hooks.verify(input(changed))).toEqual({ ok: false, reason: "bad_signature" });
    expect(await hooks.verify(input(sample, MAILCHANNELS_FIXTURE_OTHER_PUBLIC_KEY))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a digest header that matches a changed body but not the signature", async () => {
    const sample = await signed(THREE_EVENTS);
    const body = utf8(THREE_EVENTS.replace("ana", "eve"));
    const forged = withHeader(
      { headers: sample.headers, body },
      MAILCHANNELS_DIGEST_HEADER,
      await mailchannelsContentDigest(body),
    );
    expect(await hooks.verify(input(forged))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a created time 6 minutes old and 2 minutes in the future", async () => {
    const old = await signed(THREE_EVENTS, NOW - 6 * 60 * 1000);
    expect(await hooks.verify(input(old))).toEqual({ ok: false, reason: "stale" });
    const future = await signed(THREE_EVENTS, NOW + 2 * 60 * 1000);
    expect(await hooks.verify(input(future))).toEqual({ ok: false, reason: "stale" });
    const skew = await signed(THREE_EVENTS, NOW + 30 * 1000);
    expect(await hooks.verify(input(skew))).toEqual({ ok: true });
    const recent = await signed(THREE_EVENTS, NOW - 4 * 60 * 1000);
    expect(await hooks.verify(input(recent))).toEqual({ ok: true });
  });

  it("refuses a signed expires time in the past", async () => {
    const at = Math.floor(NOW / 1000);
    const expired = await signed(THREE_EVENTS, NOW, {
      params: `;expires=${at - 1};alg="ed25519";keyid="mckey"`,
    });
    expect(await hooks.verify(input(expired))).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a missing header and an empty secret as bad_signature", async () => {
    const sample = await signed(THREE_EVENTS);
    for (const name of [
      MAILCHANNELS_SIGNATURE_INPUT_HEADER,
      MAILCHANNELS_SIGNATURE_HEADER,
      MAILCHANNELS_DIGEST_HEADER,
    ]) {
      const headers = new Headers(sample.headers);
      headers.delete(name);
      expect(await hooks.verify(input({ headers, body: sample.body }))).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
    expect(await hooks.verify(input(sample, ""))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an alg other than ed25519, a missing alg, and an unquoted alg", async () => {
    for (const params of [
      ';alg="rsa-pss-sha512";keyid="mckey"',
      ';keyid="mckey"',
      ";alg=ed25519;keyid=mckey",
    ]) {
      const sample = await signed(THREE_EVENTS, NOW, { params });
      expect(await hooks.verify(input(sample))).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses a label mismatch, an extra component, and a repeated parameter", async () => {
    const mismatch = await signed(THREE_EVENTS, NOW, { signatureLabel: "sig_2" });
    expect(await hooks.verify(input(mismatch))).toEqual({ ok: false, reason: "malformed" });
    for (const components of ['("content-digest" "content-type")', '("content-type")', "()"]) {
      const extra = await signed(THREE_EVENTS, NOW, { components });
      expect(await hooks.verify(input(extra))).toEqual({ ok: false, reason: "malformed" });
    }
    const twice = await signed(THREE_EVENTS, NOW, {
      params: ';alg="ed25519";alg="ed25519";keyid="mckey"',
    });
    expect(await hooks.verify(input(twice))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses two signatures and broken header values as malformed", async () => {
    const sample = await signed(THREE_EVENTS);
    const signature = sample.headers.get(MAILCHANNELS_SIGNATURE_HEADER) ?? "";
    const input1 = sample.headers.get(MAILCHANNELS_SIGNATURE_INPUT_HEADER) ?? "";
    const digest = sample.headers.get(MAILCHANNELS_DIGEST_HEADER) ?? "";
    const cases: [string, string][] = [
      [MAILCHANNELS_SIGNATURE_HEADER, `${signature}, sig_2=:AAAA:`],
      [MAILCHANNELS_SIGNATURE_HEADER, "sig_1=:AAAA:"],
      [MAILCHANNELS_SIGNATURE_HEADER, "sig_1=not-bytes"],
      [MAILCHANNELS_SIGNATURE_INPUT_HEADER, `${input1}, sig_2=("content-digest")`],
      [MAILCHANNELS_SIGNATURE_INPUT_HEADER, input1.replace(/created=\d+/, "created=soon")],
      [MAILCHANNELS_DIGEST_HEADER, digest.replace("sha-256", "sha-512")],
      [MAILCHANNELS_DIGEST_HEADER, `${digest}, ${digest}`],
      [MAILCHANNELS_DIGEST_HEADER, "sha-256=plain"],
    ];
    for (const [name, value] of cases) {
      expect(
        await hooks.verify(input(withHeader(sample, name, value))),
        `${name}: ${value}`,
      ).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("selects the sha-256 entry of a digest with more than one entry", async () => {
    const body = utf8(THREE_EVENTS);
    const digest = await mailchannelsContentDigest(body);
    const sample = await signed(THREE_EVENTS);
    // The signature covers the header value, so a second entry breaks the signature.
    const both = withHeader(sample, MAILCHANNELS_DIGEST_HEADER, `sha-512=:AAAA:, ${digest}`);
    expect(await hooks.verify(input(both))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signed body that is not a JSON array, or holds more than 1000 events", async () => {
    const single = await signed(JSON.stringify(mailchannelsEvent("delivered")));
    expect(await hooks.verify(input(single))).toEqual({ ok: false, reason: "malformed" });
    const many = await signed(
      JSON.stringify(Array.from({ length: 1001 }, () => mailchannelsEvent("processed"))),
    );
    expect(await hooks.verify(input(many))).toEqual({ ok: false, reason: "malformed" });
  });

  it("throws at setup for a key that is not base64, with no key in the message", async () => {
    const sample = await signed(THREE_EVENTS);
    const secret = "not a key at all!";
    const error = await hooks.verify(input(sample, secret)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(secret);
  });

  it("throws at setup for a PEM block that is not a PUBLIC KEY", async () => {
    const sample = await signed(THREE_EVENTS);
    for (const label of ["PRIVATE KEY", "CERTIFICATE"]) {
      const secret = `-----BEGIN ${label}-----\n${PUBLIC_KEY}\n-----END ${label}-----\n`;
      const error = await hooks.verify(input(sample, secret)).catch((caught: unknown) => caught);
      expect(error).toEqual(
        new TypeError("The MailChannels webhook secret is not a base64 public key."),
      );
      expect((error as Error).message).not.toContain(PUBLIC_KEY);
    }
  });

  it("gives unknown for an unmapped event and reads recipients with care", () => {
    const body = utf8(
      JSON.stringify([
        mailchannelsEvent("processed"),
        mailchannelsEvent("dropped", { recipients: ["a@example.org", "B@example.org"] }),
        mailchannelsEvent("test", { recipients: [{ email: "c@example.org" }] }),
        { event: "open", customer_handle: "acct-test", timestamp: 5 },
        "not an event",
      ]),
    );
    const events = hooks.parse(body, new Headers());
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ type: "unknown", rawType: "processed" });
    expect(events[1]).toMatchObject({
      type: "unknown",
      eventKey: "mc-request-0001:dropped:a@example.org,b@example.org:1793102340:",
    });
    expect(events[1]).not.toHaveProperty("recipient");
    expect(events[2]).toMatchObject({ rawType: "test", recipient: "c@example.org" });
    expect(events[3]).toMatchObject({ eventKey: ":open::5:", occurredAt: 5000 });
    expect(events.some((event) => "bounce" in event)).toBe(false);
    expect(hooks.parse(utf8("{}"), new Headers())).toEqual([]);
  });

  it("is marked as needing a dedupe store and signs a timestamp", () => {
    expect(mailchannels().requiresDedupe).toBe(true);
    expect(mailchannels().webhooks.signedTimestamp).toBe(true);
  });

  it("drops a replayed signed request inside the window through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = mailchannels();
    const sample = await signed(THREE_EVENTS);
    const deliver = () =>
      handleWebhook(
        new Request("https://app.example.com/webhooks/mailchannels", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: PUBLIC_KEY, dedupe, now: () => NOW + 60_000 },
      );
    const first = await deliver();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toHaveLength(3);
    await first.ack();
    expect(await deliver()).toMatchObject({ ok: true, events: [] });
  });
});
