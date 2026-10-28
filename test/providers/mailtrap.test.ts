import { describe, expect, it } from "vitest";
import {
  MAILTRAP_FIXTURE_ACCOUNTS_URL,
  MAILTRAP_FIXTURE_EVENT_TIME,
  MAILTRAP_FIXTURE_MESSAGE_ID,
  MAILTRAP_FIXTURE_SECRET,
  MAILTRAP_FIXTURE_SEND_URL,
  MAILTRAP_FIXTURE_TOKEN,
  mailtrapAccepted,
  mailtrapError,
  mailtrapEvent,
  mailtrapEvents,
  signMailtrapWebhook,
} from "../../src/conformance/fixtures/mailtrap";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import { sha256Hex } from "../../src/internal/sha256";
import {
  MAILTRAP_HOSTS,
  MAILTRAP_SIGNATURE_HEADER,
  mailtrap,
  mailtrapMeta,
  mailtrapSignature,
  parseMailtrapEvents,
} from "../../src/providers/mailtrap/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = MAILTRAP_FIXTURE_SEND_URL;
const ACCOUNTS_URL = MAILTRAP_FIXTURE_ACCOUNTS_URL;
const TOKEN = MAILTRAP_FIXTURE_TOKEN;
const SECRET = MAILTRAP_FIXTURE_SECRET;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");

function context(exchanges: RecordedExchange[], credentials: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = {
    fetch: mock.fetch,
    timeoutMs: 5_000,
    credentials: { apiKey: TOKEN, ...credentials },
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

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: "Acme Billing <billing@example.com>",
    to: ["ana@example.org"],
    subject: "Your invoice",
    html: '<p>Invoice attached.</p><img src="cid:logo">',
    text: "Invoice attached.",
    ...overrides,
  };
}

describe("mailtrap send", () => {
  it("maps a full message with an inline image to the documented payload", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([exchange(SEND_URL, 200, mailtrapAccepted(["mt-1", "mt-2"]))]);
    const result = await mailtrap().send(
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
    expect(result).toEqual({ status: "sent", provider: "mailtrap", providerMessageId: "mt-1" });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("api-token")).toBe(TOKEN);
    expect(call?.headers.has("authorization")).toBe(false);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      from: { email: "billing@example.com", name: "Acme Billing" },
      to: [{ email: "ana@example.org" }, { email: "bo@example.org", name: "Bo, Jr." }],
      cc: [{ email: "cc@example.org", name: "Cy" }],
      bcc: [{ email: "bcc@example.org" }],
      reply_to: { email: "support@example.com", name: "Support" },
      subject: "Your invoice",
      text: "Invoice attached.",
      html: '<p>Invoice attached.</p><img src="cid:logo">',
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

  it("uses the apiKey option when the credential is empty", async () => {
    const { mock, ctx } = context([exchange(SEND_URL, 200, mailtrapAccepted())], { apiKey: "" });
    const result = await mailtrap({ apiKey: TOKEN }).send(message(), ctx);
    expect(result.status).toBe("sent");
    expect(mock.calls[0]?.headers.get("api-token")).toBe(TOKEN);
  });

  it("sends to the bulk host and to the sandbox inbox", async () => {
    const bulkUrl = `${MAILTRAP_HOSTS.bulk}/api/send`;
    const bulk = context([exchange(bulkUrl, 200, mailtrapAccepted())]);
    expect(await mailtrap({ stream: "bulk" }).send(message(), bulk.ctx)).toMatchObject({
      status: "sent",
    });
    expect(bulk.mock.calls[0]?.url).toBe(bulkUrl);
    const sandboxUrl = `${MAILTRAP_HOSTS.sandbox}/api/send/123456`;
    const sandbox = context([exchange(sandboxUrl, 200, mailtrapAccepted())]);
    expect(await mailtrap({ sandboxInboxId: "123456" }).send(message(), sandbox.ctx)).toMatchObject(
      { status: "sent" },
    );
    expect(sandbox.mock.calls[0]?.url).toBe(sandboxUrl);
    const explicit = context([exchange(SEND_URL, 200, mailtrapAccepted())]);
    await mailtrap({ stream: "transactional" }).send(message(), explicit.ctx);
    expect(explicit.mock.calls[0]?.url).toBe(SEND_URL);
  });

  it("puts the sandbox path on a baseUrl", async () => {
    const url = "http://localhost:8787/api/send/42";
    const { mock, ctx } = context([exchange(url, 200, mailtrapAccepted())]);
    await mailtrap({ baseUrl: "http://localhost:8787/", sandboxInboxId: "42" }).send(
      message(),
      ctx,
    );
    expect(mock.calls[0]?.url).toBe(url);
  });

  it("sends a User-Agent on every request", async () => {
    const { mock, ctx } = context([
      exchange(SEND_URL, 200, mailtrapAccepted()),
      exchange(ACCOUNTS_URL, 200, [], "GET"),
    ]);
    const adapter = mailtrap();
    await adapter.send(message(), ctx);
    await adapter.verify(ctx);
    expect(mock.calls).toHaveLength(2);
    for (const call of mock.calls) expect(call.headers.get("user-agent")).toBe("mailswitch");
  });

  it("refuses more than 1000 recipients with no request", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `r${i}@example.org`);
    const { mock, ctx } = context([]);
    expect(await mailtrap().send(message({ to: many }), ctx)).toMatchObject({
      status: "not_sent",
      reason: "unsupported",
      provider: "mailtrap",
    });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("mailtrap accepted answers", () => {
  it("keeps every 2xx that is not success with an id unknown", async () => {
    const bodies: unknown[] = [
      { success: true, message_ids: [] },
      { success: true },
      { success: false, message_ids: ["mt-1"] },
      { message_ids: ["mt-1"] },
      { success: true, message_ids: [42] },
      { success: true, message_ids: [""] },
      [],
      "not json",
      "",
    ];
    for (const body of bodies) {
      const { ctx } = context([exchange(SEND_URL, 200, body)]);
      expect(await mailtrap().send(message(), ctx), JSON.stringify(body)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        provider: "mailtrap",
      });
    }
    const { ctx } = context([exchange(SEND_URL, 202, mailtrapAccepted())]);
    expect(await mailtrap().send(message(), ctx)).toMatchObject({ status: "sent" });
  });
});

describe("mailtrap failures", () => {
  it("maps the documented 4xx answers with the default table", async () => {
    const cases: [number, string][] = [
      [400, "invalid_message"],
      [401, "auth"],
      [403, "auth"],
      [404, "rejected"],
    ];
    for (const [status, reason] of cases) {
      const { ctx } = context([exchange(SEND_URL, status, mailtrapError("error"))]);
      expect(await mailtrap().send(message(), ctx)).toMatchObject({
        status: "not_sent",
        reason,
        httpStatus: status,
        provider: "mailtrap",
      });
    }
  });

  it("gives rate_limited for a 429 with or without Retry-After", async () => {
    const timed = context([
      exchange(SEND_URL, 429, mailtrapError("slow"), "POST", { "retry-after": "3" }),
    ]);
    expect(await mailtrap().send(message(), timed.ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 3000,
    });
    const bare = context([exchange(SEND_URL, 429, mailtrapError("slow"))]);
    expect(await mailtrap().send(message(), bare.ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
    });
  });

  it("keeps a 500, a 503, a timeout, and a network error unknown", async () => {
    for (const status of [500, 502, 503]) {
      const { ctx } = context([exchange(SEND_URL, status, mailtrapError("down"))]);
      expect(await mailtrap().send(message(), ctx)).toMatchObject({ status: "unknown" });
    }
    for (const response of ["timeout", "network"] as const) {
      const { ctx } = context([{ label: response, method: "POST", url: SEND_URL, response }]);
      expect(await mailtrap().send(message(), { ...ctx, timeoutMs: 50 })).toMatchObject({
        status: "unknown",
      });
    }
  });

  it("keeps the token and the response body out of a failure", async () => {
    const { ctx } = context([exchange(SEND_URL, 401, mailtrapError(`bad token ${TOKEN}`))]);
    const result = await mailtrap().send(message(), ctx);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("bad token");
  });
});

describe("mailtrap verify", () => {
  it("calls GET https://mailtrap.io/api/accounts and maps the answers", async () => {
    const good = context([exchange(ACCOUNTS_URL, 200, [{ id: 1 }], "GET")]);
    expect(await mailtrap().verify(good.ctx)).toEqual({ ok: true });
    expect(good.mock.calls[0]?.headers.get("api-token")).toBe(TOKEN);
    for (const status of [401, 403]) {
      const bad = context([exchange(ACCOUNTS_URL, status, { error: "no" }, "GET")]);
      expect(await mailtrap().verify(bad.ctx)).toMatchObject({
        ok: false,
        status: "not_sent",
        reason: "auth",
      });
    }
    const down = context([exchange(ACCOUNTS_URL, 503, "", "GET")]);
    expect(await mailtrap().verify(down.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });

  it("keeps the accounts host when baseUrl changes, and takes accountsUrl", async () => {
    const kept = context([exchange(ACCOUNTS_URL, 200, [], "GET")]);
    await mailtrap({ baseUrl: "https://proxy.example.com", stream: "bulk" }).verify(kept.ctx);
    expect(kept.mock.calls[0]?.url).toBe(ACCOUNTS_URL);
    const url = "https://accounts.example.com/api/accounts";
    const moved = context([exchange(url, 200, [], "GET")]);
    await mailtrap({ accountsUrl: "https://accounts.example.com/" }).verify(moved.ctx);
    expect(moved.mock.calls[0]?.url).toBe(url);
  });
});

describe("mailtrap options", () => {
  it("throws a TypeError for invalid options", () => {
    expect(() => mailtrap({ stream: "marketing" as "bulk" })).toThrow(TypeError);
    expect(() => mailtrap({ sandboxInboxId: "inbox-1" })).toThrow(TypeError);
    expect(() => mailtrap({ sandboxInboxId: 42 as unknown as string })).toThrow(TypeError);
    expect(() => mailtrap({ sandboxInboxId: "42", stream: "bulk" })).toThrow(TypeError);
    expect(() => mailtrap({ baseUrl: "http://send.api.mailtrap.io" })).toThrow(TypeError);
    expect(() => mailtrap({ accountsUrl: "ftp://mailtrap.io" })).toThrow(TypeError);
    expect(() => mailtrap({ apiKey: 1 as unknown as string })).toThrow(TypeError);
    expect(() => mailtrap(null as unknown as object)).toThrow(TypeError);
  });

  it("marks requiresDedupe and no signed timestamp", () => {
    const adapter = mailtrap();
    expect(adapter.requiresDedupe).toBe(true);
    expect(adapter.webhooks.signedTimestamp).toBe(false);
  });
});

describe("mailtrap meta", () => {
  it("declares tier 1 with the documented limits", () => {
    expect(mailtrapMeta.tier).toBe(1);
    expect(mailtrapMeta.webhooks).toBe(true);
    expect(mailtrapMeta.nativeIdempotency).toBe(false);
    expect(mailtrapMeta.capabilities.maxMessageBytes).toBe(10_000_000);
    expect(mailtrapMeta.capabilities.maxRecipients).toBe(1000);
    expect(mailtrapMeta.capabilities.batchSize).toBe(1);
  });

  it("checks the token pattern", () => {
    const pattern = new RegExp(mailtrapMeta.credentialFields[0]?.pattern ?? "");
    expect(pattern.test(TOKEN)).toBe(true);
    expect(pattern.test("short")).toBe(false);
    expect(pattern.test("has a space in the token text")).toBe(false);
  });
});

describe("mailtrap webhooks", () => {
  const hooks = mailtrap().webhooks;
  const body = utf8(
    mailtrapEvents(mailtrapEvent("delivery"), mailtrapEvent("bounce", { email: "bo@example.org" })),
  );

  it("passes a body signed with the hex HMAC of the secret", async () => {
    const sample = await signMailtrapWebhook({ body, secret: SECRET });
    expect(sample.headers.get(MAILTRAP_SIGNATURE_HEADER)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hooks.verify({ ...sample, secret: SECRET, now: NOW })).toEqual({ ok: true });
    const upper = new Headers(sample.headers);
    upper.set(
      MAILTRAP_SIGNATURE_HEADER,
      ` ${upper.get(MAILTRAP_SIGNATURE_HEADER)?.toUpperCase()} `,
    );
    expect(await hooks.verify({ headers: upper, body, secret: SECRET, now: NOW })).toEqual({
      ok: true,
    });
  });

  it("gives typed rejections for a changed body, a wrong secret, and bad headers", async () => {
    const sample = await signMailtrapWebhook({ body, secret: SECRET });
    const changed = utf8(mailtrapEvents(mailtrapEvent("spam")));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(await hooks.verify({ ...sample, secret: "other-secret", now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await hooks.verify({ ...sample, secret: "", now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await hooks.verify({ headers: new Headers(), body, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const broken = new Headers({ [MAILTRAP_SIGNATURE_HEADER]: "sha256=abc" });
    expect(await hooks.verify({ headers: broken, body, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a signed body that is not an object with an events list", async () => {
    for (const text of ["[]", '{"event":"delivery"}', '{"events":{}}', "not json"]) {
      const signed = await signMailtrapWebhook({ body: utf8(text), secret: SECRET });
      expect(await hooks.verify({ ...signed, secret: SECRET, now: NOW }), text).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("parses a body with two events into two events", () => {
    expect(parseMailtrapEvents("mailtrap", body)).toEqual([
      {
        type: "delivered",
        provider: "mailtrap",
        eventKey: "mailtrap-event-delivery-0001",
        rawType: "delivery",
        recipient: "ana@example.org",
        providerMessageId: MAILTRAP_FIXTURE_MESSAGE_ID,
        occurredAt: MAILTRAP_FIXTURE_EVENT_TIME * 1000,
      },
      {
        type: "bounced",
        bounce: "hard",
        provider: "mailtrap",
        eventKey: "mailtrap-event-bounce-0001",
        rawType: "bounce",
        recipient: "bo@example.org",
        providerMessageId: MAILTRAP_FIXTURE_MESSAGE_ID,
        occurredAt: MAILTRAP_FIXTURE_EVENT_TIME * 1000,
      },
    ]);
  });

  it("maps every documented event type", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["delivery", { type: "delivered" }],
      ["bounce", { type: "bounced", bounce: "hard" }],
      ["soft bounce", { type: "bounced", bounce: "soft" }],
      ["spam", { type: "complained" }],
      ["reject", { type: "unknown" }],
      ["suspension", { type: "unknown" }],
      ["unsubscribe", { type: "unsubscribed" }],
      ["open", { type: "unknown" }],
      ["click", { type: "unknown" }],
    ];
    for (const [rawType, expected] of cases) {
      const [event] = parseMailtrapEvents("mailtrap", utf8(mailtrapEvents(mailtrapEvent(rawType))));
      expect(event, rawType).toMatchObject({ ...expected, rawType });
      if (expected.type !== "bounced") expect(event?.bounce).toBeUndefined();
    }
  });

  it("keys an entry with no event_id by the body hash and index, and skips non-objects", () => {
    const raw = utf8(
      JSON.stringify({
        events: ["text", { event: "delivery" }, { event: "open", timestamp: "x" }],
      }),
    );
    const events = parseMailtrapEvents("mailtrap", raw);
    expect(events.map((event) => event.eventKey)).toEqual([
      `${sha256Hex(raw)}:1`,
      `${sha256Hex(raw)}:2`,
    ]);
    expect(events[1]?.occurredAt).toBeUndefined();
    expect(parseMailtrapEvents("mailtrap", utf8("not json"))).toEqual([]);
    expect(parseMailtrapEvents("mailtrap", utf8('{"events":[]}'))).toEqual([]);
  });

  it("gives the signature that the fixture signer gives", async () => {
    const sample = await signMailtrapWebhook({ body, secret: SECRET });
    expect(sample.headers.get(MAILTRAP_SIGNATURE_HEADER)).toBe(
      await mailtrapSignature(SECRET, body),
    );
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const sample = await signMailtrapWebhook({
      body: utf8(mailtrapEvents(mailtrapEvent("soft bounce"))),
      secret: SECRET,
    });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/mailtrap", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter: mailtrap(), secret: SECRET, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "soft" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });
});

describe("mailtrap unsubscribe", () => {
  it("maps unsubscribe to unsubscribed with the recipient and message id", () => {
    const body = utf8(mailtrapEvents(mailtrapEvent("unsubscribe", { email: "cy@example.org" })));
    const events = parseMailtrapEvents("mailtrap", body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unsubscribed",
      rawType: "unsubscribe",
      recipient: "cy@example.org",
      providerMessageId: MAILTRAP_FIXTURE_MESSAGE_ID,
      eventKey: "mailtrap-event-unsubscribe-0001",
    });
  });
});
