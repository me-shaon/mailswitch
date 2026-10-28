import { describe, expect, it } from "vitest";
import {
  SENDGRID_FIXTURE_OTHER_PUBLIC_KEY,
  SENDGRID_FIXTURE_PUBLIC_KEY,
  sendgridEvent,
  signSendgridWebhook,
} from "../../src/conformance/fixtures/sendgrid";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  SENDGRID_API_BASE,
  SENDGRID_EU_API_BASE,
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
  sendgrid,
} from "../../src/providers/sendgrid/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = `${SENDGRID_API_BASE}/v3/mail/send`;
const SCOPES_URL = `${SENDGRID_API_BASE}/v3/scopes`;
const KEY = "SG.test-sendgrid-key-not-real";
const PUBLIC_KEY = SENDGRID_FIXTURE_PUBLIC_KEY;
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
  headers: Record<string, string> = {},
  body: unknown = "",
  method = "POST",
): RecordedExchange {
  return { label: `${method} ${url} ${status}`, method, url, response: { status, headers, body } };
}

function accepted(id = "msg-1", status = 202): RecordedExchange {
  return exchange(SEND_URL, status, { "x-message-id": id });
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

const FOUR_EVENTS = JSON.stringify([
  sendgridEvent("delivered"),
  sendgridEvent("bounce", { type: "bounce" }),
  sendgridEvent("bounce", { type: "blocked", sg_event_id: "sg-blocked-2" }),
  sendgridEvent("spamreport"),
]);

async function signed(body: string, at = NOW) {
  return signSendgridWebhook({ body: utf8(body), secret: PUBLIC_KEY, at });
}

describe("sendgrid send", () => {
  it("maps a full message to the documented payload and returns sent", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([accepted("W4bXK2lzRz")]);
    const result = await sendgrid().send(
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
    expect(result).toEqual({
      status: "sent",
      provider: "sendgrid",
      providerMessageId: "W4bXK2lzRz",
    });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.headers.get("content-type")).toBe("application/json");
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
        {
          content: bytesToBase64(pdf),
          filename: "invoice.pdf",
          type: "application/pdf",
          disposition: "attachment",
        },
        {
          content: bytesToBase64(utf8("png")),
          filename: "logo.png",
          type: "image/png",
          disposition: "inline",
          content_id: "logo",
        },
      ],
    });
  });

  it("sends only the parts that the message has, and no idempotency key", async () => {
    const { mock, ctx } = context([accepted()]);
    await sendgrid().send(
      message({ html: undefined, idempotencyKey: "invoice-1" }) as OutgoingMessage,
      ctx,
    );
    const body = JSON.parse(mock.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.content).toEqual([{ type: "text/plain", value: "Invoice attached." }]);
    expect(body).not.toHaveProperty("reply_to");
    expect(body).not.toHaveProperty("headers");
    expect(body).not.toHaveProperty("attachments");
    expect(body).not.toHaveProperty("mail_settings");
    expect(mock.calls[0]?.body).not.toContain("invoice-1");
    expect([...(mock.calls[0]?.headers.values() ?? [])]).not.toContain("invoice-1");
  });

  it("treats a 200 sandbox answer as sent and sets sandbox mode", async () => {
    const { mock, ctx } = context([accepted("sandbox-1", 200)]);
    const result = await sendgrid({ sandbox: true }).send(message(), ctx);
    expect(result).toEqual({
      status: "sent",
      provider: "sendgrid",
      providerMessageId: "sandbox-1",
    });
    expect(JSON.parse(mock.calls[0]?.body ?? "{}").mail_settings).toEqual({
      sandbox_mode: { enable: true },
    });
  });

  it("gives sent with no id when the X-Message-Id header is missing", async () => {
    const { ctx } = context([exchange(SEND_URL, 202)]);
    expect(await sendgrid().send(message(), ctx)).toEqual({ status: "sent", provider: "sendgrid" });
  });

  it("maps 400, 401, 403, and 413 and keeps the body out of the result", async () => {
    const cases: [number, string][] = [
      [400, "invalid_message"],
      [401, "auth"],
      [403, "auth"],
      [413, "invalid_message"],
    ];
    for (const [status, reason] of cases) {
      const { ctx } = context([
        exchange(SEND_URL, status, {}, { errors: [{ message: "secret-ish body text" }] }),
      ]);
      const result = await sendgrid().send(message(), ctx);
      expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: status });
      expect(result.provider).toBe("sendgrid");
      expect(JSON.stringify(result)).not.toContain("secret-ish");
    }
  });

  it("computes retryAfterMs of a 429 from X-RateLimit-Reset", async () => {
    const reset = String(Math.floor(NOW / 1000) + 30);
    const { ctx } = context([exchange(SEND_URL, 429, { "x-ratelimit-reset": reset })]);
    const result = await sendgrid().send(message(), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "rate_limited" });
    // The fixed clock is 30.000 s past the minute, so the delay is exactly 30 s.
    expect(result.status === "not_sent" && result.retryAfterMs).toBe(30_000);
  });

  it("prefers Retry-After, and gives 0 for a reset time in the past", async () => {
    const past = String(Math.floor(NOW / 1000) - 5);
    const first = context([
      exchange(SEND_URL, 429, { "retry-after": "7", "x-ratelimit-reset": past }),
    ]);
    expect(await sendgrid().send(message(), first.ctx)).toMatchObject({ retryAfterMs: 7000 });
    const second = context([exchange(SEND_URL, 429, { "x-ratelimit-reset": past })]);
    expect(await sendgrid().send(message(), second.ctx)).toMatchObject({ retryAfterMs: 0 });
    const third = context([exchange(SEND_URL, 429, { "x-ratelimit-reset": "soon" })]);
    const result = await sendgrid().send(message(), third.ctx);
    expect(result).toMatchObject({ reason: "rate_limited" });
    expect(result).not.toHaveProperty("retryAfterMs");
  });

  it("keeps a 500, a 503, a timeout, and a network error unknown", async () => {
    for (const status of [500, 503]) {
      const { ctx } = context([exchange(SEND_URL, status)]);
      expect(await sendgrid().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
      });
    }
    const slow = context([
      { label: "timeout", method: "POST", url: SEND_URL, response: "timeout" },
    ]);
    expect(await sendgrid().send(message(), slow.ctx)).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
    const down = context([
      { label: "network", method: "POST", url: SEND_URL, response: "network" },
    ]);
    expect(await sendgrid().send(message(), down.ctx)).toMatchObject({
      status: "unknown",
      reason: "network",
    });
  });

  it("refuses a from name with non-ASCII characters before any request", async () => {
    for (const from of [
      "Café Acme <billing@example.com>",
      { email: "billing@example.com", name: "Ünal" },
    ]) {
      const { mock, ctx } = context([accepted()]);
      expect(await sendgrid().send(message({ from }), ctx)).toMatchObject({
        status: "not_sent",
        reason: "unsupported",
        provider: "sendgrid",
      });
      expect(mock.calls).toHaveLength(0);
    }
    // A non-ASCII name of a recipient is fine.
    const { mock, ctx } = context([accepted()]);
    await sendgrid().send(message({ to: [{ email: "ana@example.org", name: "Ána" }] }), ctx);
    expect(mock.calls).toHaveLength(1);
  });

  it("refuses more than 1000 recipients before any request", async () => {
    const { mock, ctx } = context([accepted()]);
    const to = Array.from({ length: 1001 }, (_, index) => `r${index}@example.org`);
    expect(await sendgrid().send(message({ to }), ctx)).toMatchObject({ status: "not_sent" });
    expect(mock.calls).toHaveLength(0);
  });

  it("sends to the EU host with baseUrl, and uses the option key", async () => {
    const mock = mockFetch([exchange(`${SENDGRID_EU_API_BASE}/v3/mail/send`, 202)]);
    const ctx: SendContext = { fetch: mock.fetch, timeoutMs: 5_000, credentials: {}, now: NOW };
    const adapter = sendgrid({ baseUrl: `${SENDGRID_EU_API_BASE}/`, apiKey: KEY });
    expect(await adapter.send(message(), ctx)).toMatchObject({ status: "sent" });
    expect(mock.calls[0]?.url).toBe("https://api.eu.sendgrid.com/v3/mail/send");
    expect(mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("throws a TypeError for invalid options", () => {
    expect(() => sendgrid({ baseUrl: "http://api.sendgrid.com" })).toThrow(TypeError);
    expect(() => sendgrid({ baseUrl: "https://key@api.sendgrid.com" })).toThrow(TypeError);
    expect(() => sendgrid({ sandbox: "yes" as unknown as boolean })).toThrow(TypeError);
    expect(() => sendgrid(null as unknown as object)).toThrow(TypeError);
    expect(() => sendgrid({ baseUrl: "http://localhost:8787" })).not.toThrow();
  });

  it("throws a TypeError for an apiKey that is not a string", () => {
    expect(() => sendgrid({ apiKey: 42 as unknown as string })).toThrow(
      new TypeError("sendgrid: apiKey must be a string."),
    );
  });
});

describe("sendgrid verify", () => {
  it("is ok with mail.send in the scope list", async () => {
    const { mock, ctx } = context([
      exchange(SCOPES_URL, 200, {}, { scopes: ["mail.send"] }, "GET"),
    ]);
    expect(await sendgrid().verify(ctx)).toEqual({ ok: true });
    expect(mock.calls[0]?.method).toBe("GET");
    expect(mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("is not_sent/auth without mail.send, and for a 401", async () => {
    const missing = context([
      exchange(SCOPES_URL, 200, {}, { scopes: ["user.profile.read"] }, "GET"),
    ]);
    expect(await sendgrid().verify(missing.ctx)).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
      provider: "sendgrid",
    });
    const bad = context([exchange(SCOPES_URL, 401, {}, { errors: [] }, "GET")]);
    expect(await sendgrid().verify(bad.ctx)).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
  });

  it("is unknown for a body it cannot read and for a 5xx", async () => {
    const odd = context([exchange(SCOPES_URL, 200, {}, "not json", "GET")]);
    expect(await sendgrid().verify(odd.ctx)).toMatchObject({ ok: false, status: "unknown" });
    const down = context([exchange(SCOPES_URL, 503, {}, "", "GET")]);
    expect(await sendgrid().verify(down.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });
});

describe("sendgrid webhooks", () => {
  const hooks = sendgrid().webhooks;

  function input(sample: { headers: Headers; body: Uint8Array }, secret = PUBLIC_KEY) {
    return { headers: sample.headers, body: sample.body, secret, now: NOW };
  }

  it("accepts a signed body and parses four events into the four mapped types", async () => {
    const sample = await signed(FOUR_EVENTS);
    expect(await hooks.verify(input(sample))).toEqual({ ok: true });
    const events = hooks.parse(sample.body, sample.headers);
    expect(events.map((event) => [event.type, event.bounce, event.rawType])).toEqual([
      ["delivered", undefined, "delivered"],
      ["bounced", "hard", "bounce"],
      ["bounced", "soft", "bounce"],
      ["complained", undefined, "spamreport"],
    ]);
    expect(events.map((event) => event.eventKey)).toEqual([
      "sg-delivered-0001",
      "sg-bounce-0001",
      "sg-blocked-2",
      "sg-spamreport-0001",
    ]);
    expect(events[0]).toMatchObject({ provider: "sendgrid", recipient: "ana@example.org" });
  });

  it("accepts a key in PEM form", async () => {
    const pem = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY.slice(0, 64)}\n${PUBLIC_KEY.slice(64)}\n-----END PUBLIC KEY-----\n`;
    const sample = await signed(FOUR_EVENTS);
    expect(await hooks.verify(input(sample, pem))).toEqual({ ok: true });
  });

  it("refuses a changed body, a wrong key, a stale timestamp, and a missing signature", async () => {
    const sample = await signed(FOUR_EVENTS);
    const changed = { headers: sample.headers, body: utf8(FOUR_EVENTS.replace("ana", "eve")) };
    expect(await hooks.verify(input(changed))).toEqual({ ok: false, reason: "bad_signature" });
    expect(await hooks.verify(input(sample, SENDGRID_FIXTURE_OTHER_PUBLIC_KEY))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const old = await signed(FOUR_EVENTS, NOW - 6 * 60 * 1000);
    expect(await hooks.verify(input(old))).toEqual({ ok: false, reason: "stale" });
    const future = await signed(FOUR_EVENTS, NOW + 6 * 60 * 1000);
    expect(await hooks.verify(input(future))).toEqual({ ok: false, reason: "stale" });
    const unsigned = new Headers(sample.headers);
    unsigned.delete(SENDGRID_SIGNATURE_HEADER);
    expect(await hooks.verify(input({ headers: unsigned, body: sample.body }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a broken timestamp, a broken signature, and an empty secret", async () => {
    const sample = await signed(FOUR_EVENTS);
    const badTime = new Headers(sample.headers);
    badTime.set(SENDGRID_TIMESTAMP_HEADER, "yesterday");
    expect(await hooks.verify(input({ headers: badTime, body: sample.body }))).toEqual({
      ok: false,
      reason: "malformed",
    });
    const badSig = new Headers(sample.headers);
    badSig.set(SENDGRID_SIGNATURE_HEADER, "!!!");
    expect(await hooks.verify(input({ headers: badSig, body: sample.body }))).toEqual({
      ok: false,
      reason: "malformed",
    });
    const notDer = new Headers(sample.headers);
    notDer.set(SENDGRID_SIGNATURE_HEADER, bytesToBase64(new Uint8Array(64)));
    expect(await hooks.verify(input({ headers: notDer, body: sample.body }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await hooks.verify(input(sample, ""))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signed body that is not a JSON array", async () => {
    const sample = await signed(JSON.stringify(sendgridEvent("delivered")));
    expect(await hooks.verify(input(sample))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a key that is not base64 as invalid_secret", async () => {
    const sample = await signed(FOUR_EVENTS);
    expect(await hooks.verify(input(sample, "not a key at all!"))).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
  });

  it("gives unknown for an unmapped event and for a bounce of another type", () => {
    const body = utf8(
      JSON.stringify([
        sendgridEvent("open"),
        sendgridEvent("bounce", { type: "other", sg_event_id: "sg-bounce-x" }),
        { event: "dropped", email: "ana@example.org", timestamp: 1, sg_message_id: "m" },
        "not an event",
      ]),
    );
    const events = hooks.parse(body, new Headers());
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "unknown", rawType: "open" });
    expect(events[1]).toMatchObject({ type: "unknown", rawType: "bounce" });
    expect(events[1]).not.toHaveProperty("bounce");
    // No sg_event_id: the key falls back to stable fields and the index.
    expect(events[2]).toMatchObject({
      type: "unknown",
      rawType: "dropped",
      eventKey: "m:dropped:1:ana@example.org:2",
      occurredAt: 1000,
    });
    expect(hooks.parse(utf8("{}"), new Headers())).toEqual([]);
  });

  it("is marked as needing a dedupe store and signs a timestamp", () => {
    expect(sendgrid().requiresDedupe).toBe(true);
    expect(sendgrid().webhooks.signedTimestamp).toBe(true);
  });

  it("drops a retry of one event through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = sendgrid();
    const deliver = async (at: number) => {
      const sample = await signed(FOUR_EVENTS, at);
      return handleWebhook(
        new Request("https://app.example.com/webhooks/sendgrid", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: PUBLIC_KEY, dedupe, now: () => NOW },
      );
    };
    const first = await deliver(NOW);
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toHaveLength(4);
    await first.ack();
    // SendGrid signs a retry again with a new timestamp. The dedupe store drops it.
    const retry = await deliver(NOW + 60_000);
    expect(retry).toMatchObject({ ok: true, events: [] });
  });
});

describe("sendgrid unsubscribe", () => {
  const parse = (events: Record<string, unknown>[]) =>
    sendgrid().webhooks?.parse(utf8(JSON.stringify(events)), new Headers()) ?? [];

  it("maps unsubscribe to unsubscribed with the recipient and message id", () => {
    const events = parse([sendgridEvent("unsubscribe", { email: "cy@example.org" })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unsubscribed",
      rawType: "unsubscribe",
      recipient: "cy@example.org",
      eventKey: "sg-unsubscribe-0001",
    });
    expect(events[0]?.providerMessageId).toMatch(/\.filterdrecv-/);
  });

  it.each(["group_unsubscribe", "group_resubscribe"])("keeps %s as unknown", (rawType) => {
    const events = parse([sendgridEvent(rawType, { asm_group_id: 10 })]);
    expect(events[0]).toMatchObject({ type: "unknown", rawType });
  });
});
