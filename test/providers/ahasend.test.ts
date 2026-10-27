import { describe, expect, it, vi } from "vitest";
import {
  AHASEND_FIXTURE_ACCOUNT_ID,
  AHASEND_FIXTURE_API_KEY,
  AHASEND_FIXTURE_DELIVERY_ID,
  AHASEND_FIXTURE_MESSAGE_ID,
  AHASEND_FIXTURE_SECRET,
  AHASEND_FIXTURE_SEND_URL,
  type AhasendEntry,
  ahasendAccepted,
  ahasendEvent,
  signAhasendWebhook,
} from "../../src/conformance/fixtures/ahasend";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import { createMailer } from "../../src/core/pipeline";
import type { OutgoingMessage } from "../../src/core/types";
import { base64ToBytes, bytesToBase64, bytesToHex, utf8 } from "../../src/internal/encoding";
import { hmacSign } from "../../src/internal/hmac";
import {
  AHASEND_API_BASE,
  AHASEND_SIGNATURE_HEADER,
  AHASEND_TIMESTAMP_HEADER,
  ahasend,
  ahasendIdempotencyKey,
  ahasendMeta,
  ahasendSignedPayload,
  parseAhasendEvents,
} from "../../src/providers/ahasend/index";
import { MemoryDedupeStore, MemoryIdempotencyStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = AHASEND_FIXTURE_SEND_URL;
const PING_URL = `${AHASEND_API_BASE}/v2/ping`;
const KEY = AHASEND_FIXTURE_API_KEY;
const ACCOUNT = AHASEND_FIXTURE_ACCOUNT_ID;
const SECRET = AHASEND_FIXTURE_SECRET;
const NOW = Date.parse("2026-10-27T12:00:30.000Z");

function context(exchanges: RecordedExchange[], credentials: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = {
    fetch: mock.fetch,
    timeoutMs: 5_000,
    credentials: { apiKey: KEY, accountId: ACCOUNT, ...credentials },
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

function accepted(entries?: AhasendEntry[]): RecordedExchange {
  return exchange(SEND_URL, 202, ahasendAccepted(entries));
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

function entry(status: string, id: string | null = null, recipient = "ana@example.org") {
  return { id, recipient, status, error: status === "error" ? "Recipient refused" : null };
}

describe("ahasend send", () => {
  it("maps a full message to the documented payload and returns sent", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([accepted([entry("queued", "aha-1")])]);
    const result = await ahasend().send(
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
    expect(result).toEqual({ status: "sent", provider: "ahasend", providerMessageId: "aha-1" });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.has("idempotency-key")).toBe(false);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      from: { email: "billing@example.com", name: "Acme Billing" },
      to: [{ email: "ana@example.org" }, { email: "bo@example.org", name: "Bo, Jr." }],
      cc: [{ email: "cc@example.org", name: "Cy" }],
      bcc: [{ email: "bcc@example.org" }],
      reply_to: { email: "support@example.com", name: "Support" },
      subject: "Your invoice",
      text_content: "Invoice attached.",
      html_content: "<p>Invoice attached.</p>",
      headers: { "X-Invoice": "INV-1" },
      attachments: [
        {
          data: bytesToBase64(pdf),
          base64: true,
          content_type: "application/pdf",
          file_name: "invoice.pdf",
        },
        {
          data: bytesToBase64(utf8("png")),
          base64: true,
          content_type: "image/png",
          file_name: "logo.png",
          content_id: "<logo>",
          content_disposition: "inline",
        },
      ],
    });
  });

  it("uses the options when the credentials leave the key and the account empty", async () => {
    const { mock, ctx } = context([accepted()], { apiKey: "", accountId: "" });
    const result = await ahasend({ apiKey: KEY, accountId: ACCOUNT }).send(message(), ctx);
    expect(result.status).toBe("sent");
    expect(mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(mock.calls[0]?.url).toBe(SEND_URL);
  });

  it("adds sandbox: true in sandbox mode", async () => {
    const { mock, ctx } = context([accepted()]);
    await ahasend({ sandbox: true }).send(message(), ctx);
    expect(JSON.parse(mock.calls[0]?.body ?? "{}").sandbox).toBe(true);
  });

  it("refuses a missing account id with no request", async () => {
    const { mock, ctx } = context([], { accountId: "" });
    const result = await ahasend().send(message(), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "auth", provider: "ahasend" });
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses more than 50 addresses in one list and a custom Message-ID with no request", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@example.org`);
    const { mock, ctx } = context([]);
    const adapter = ahasend();
    expect(await adapter.send(message({ to: many }), ctx)).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
    });
    expect(await adapter.send(message({ cc: many }), ctx)).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
    });
    expect(
      await adapter.send(message({ headers: { "Message-ID": "<a@example.com>" } }), ctx),
    ).toMatchObject({ status: "not_sent", reason: "invalid_message" });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("ahasend idempotency", () => {
  it("sends a printable ASCII key as it is and the same bytes on a retry", async () => {
    const { mock, ctx } = context([accepted(), accepted()]);
    const adapter = ahasend();
    const keyed = message({ idempotencyKey: "order-42:receipt" });
    await adapter.send(keyed, ctx);
    await adapter.send(keyed, ctx);
    expect(mock.calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
      "order-42:receipt",
      "order-42:receipt",
    ]);
    expect(mock.calls[0]?.body).toBe(mock.calls[1]?.body);
  });

  it("sends a non-ASCII key and a key over 255 characters as SHA-256 hex", async () => {
    const hex = async (text: string) =>
      bytesToHex(await crypto.subtle.digest("SHA-256", utf8(text)));
    const unicode = "commande-é-42";
    const long = "k".repeat(256);
    expect(await ahasendIdempotencyKey(unicode)).toBe(await hex(unicode));
    expect(await ahasendIdempotencyKey(long)).toBe(await hex(long));
    expect(await ahasendIdempotencyKey("k".repeat(255))).toBe("k".repeat(255));
    const { mock, ctx } = context([accepted()]);
    await ahasend().send(message({ idempotencyKey: unicode }), ctx);
    expect(mock.calls[0]?.headers.get("idempotency-key")).toBe(await hex(unicode));
  });

  it("keeps a 409 (key in flight) and a 422 (key reused) unknown", async () => {
    for (const status of [409, 422]) {
      const { ctx } = context([
        exchange(SEND_URL, status, { message: "idempotency" }, "POST", { "retry-after": "1" }),
      ]);
      const result = await ahasend().send(message({ idempotencyKey: "k-1" }), ctx);
      expect(result).toMatchObject({
        status: "unknown",
        reason: "idempotency_conflict",
        httpStatus: status,
      });
    }
  });
});

describe("ahasend accepted answers", () => {
  it("gives sent with the id of the first queued or scheduled entry", async () => {
    const mixed = await ahasend().send(
      message({ to: ["ana@example.org", "bo@example.org"] }),
      context([accepted([entry("error"), entry("queued", "aha-2", "bo@example.org")])]).ctx,
    );
    expect(mixed).toEqual({ status: "sent", provider: "ahasend", providerMessageId: "aha-2" });
    const scheduled = await ahasend().send(
      message(),
      context([accepted([entry("scheduled", "aha-3")])]).ctx,
    );
    expect(scheduled).toMatchObject({ status: "sent", providerMessageId: "aha-3" });
  });

  it("gives not_sent/rejected when every recipient has an error entry", async () => {
    const result = await ahasend().send(
      message({ to: ["ana@example.org"], cc: ["cc@example.org"], bcc: ["bcc@example.org"] }),
      context([accepted([entry("error"), entry("error"), entry("error")])]).ctx,
    );
    expect(result).toMatchObject({ status: "not_sent", reason: "rejected", provider: "ahasend" });
  });

  it("keeps every other shape unknown", async () => {
    const two = message({ to: ["ana@example.org", "bo@example.org"] });
    const cases: [OutgoingMessage, unknown][] = [
      // Fewer error entries than recipients.
      [two, ahasendAccepted([entry("error")])],
      // More error entries than recipients.
      [message(), ahasendAccepted([entry("error"), entry("error")])],
      [message(), ahasendAccepted([])],
      [message(), ahasendAccepted([entry("sending", "aha-4")])],
      [message(), ahasendAccepted([{ id: "aha-5" }])],
      [message(), { object: "list" }],
      [message(), "not json"],
      [message(), ""],
    ];
    for (const [input, body] of cases) {
      const result = await ahasend().send(input, context([exchange(SEND_URL, 202, body)]).ctx);
      expect(result, JSON.stringify(body)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        provider: "ahasend",
      });
    }
  });
});

describe("ahasend failures", () => {
  it("maps the documented 4xx answers", async () => {
    const cases: [number, string][] = [
      [400, "invalid_message"],
      [401, "auth"],
      [403, "auth"],
      [404, "rejected"],
    ];
    for (const [status, reason] of cases) {
      const { ctx } = context([exchange(SEND_URL, status, { message: "error" })]);
      expect(await ahasend().send(message(), ctx)).toMatchObject({
        status: "not_sent",
        reason,
        httpStatus: status,
      });
    }
  });

  it("reads Retry-After on a 429", async () => {
    const { ctx } = context([
      exchange(SEND_URL, 429, { message: "slow" }, "POST", { "retry-after": "2" }),
    ]);
    expect(await ahasend().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 2000,
    });
  });

  it("keeps a 500, a 503, a timeout, and a network error unknown", async () => {
    for (const status of [500, 503]) {
      const { ctx } = context([exchange(SEND_URL, status, { message: "down" })]);
      expect(await ahasend().send(message(), ctx)).toMatchObject({ status: "unknown" });
    }
    for (const response of ["timeout", "network"] as const) {
      const { ctx } = context([{ label: response, method: "POST", url: SEND_URL, response }]);
      expect(await ahasend().send(message(), { ...ctx, timeoutMs: 50 })).toMatchObject({
        status: "unknown",
      });
    }
  });

  it("keeps the key and the response body out of a failure", async () => {
    const { ctx } = context([exchange(SEND_URL, 401, { message: `bad key ${KEY}` })]);
    const result = await ahasend().send(message(), ctx);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("bad key");
  });
});

describe("ahasend verify", () => {
  it("calls GET /v2/ping and maps the answers", async () => {
    const good = context([exchange(PING_URL, 200, { message: "pong" }, "GET")]);
    expect(await ahasend().verify(good.ctx)).toEqual({ ok: true });
    expect(good.mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    const bad = context([exchange(PING_URL, 401, { message: "Invalid API key" }, "GET")]);
    expect(await ahasend().verify(bad.ctx)).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
    const down = context([exchange(PING_URL, 503, "", "GET")]);
    expect(await ahasend().verify(down.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });
});

describe("ahasend options", () => {
  it("throws a TypeError for invalid options", () => {
    expect(() => ahasend({ baseUrl: "http://api.ahasend.com" })).toThrow(TypeError);
    expect(() => ahasend({ apiKey: 1 as unknown as string })).toThrow(TypeError);
    expect(() => ahasend({ accountId: 1 as unknown as string })).toThrow(TypeError);
    expect(() => ahasend({ sandbox: "yes" as unknown as boolean })).toThrow(TypeError);
    expect(() => ahasend(null as unknown as object)).toThrow(TypeError);
  });

  it("marks requiresDedupe", () => {
    expect(ahasend().requiresDedupe).toBe(true);
    expect(ahasend().webhooks.signedTimestamp).toBe(true);
  });
});

describe("ahasend meta", () => {
  it("declares native idempotency with a 24-hour window", () => {
    expect(ahasendMeta.tier).toBe(1);
    expect(ahasendMeta.nativeIdempotency).toBe(true);
    expect(ahasendMeta.capabilities.idempotency).toBe(true);
    expect(ahasendMeta.nativeIdempotencyWindowMs).toBe(86_400_000);
    expect(ahasendMeta.capabilities.maxMessageBytes).toBe(10_000_000);
    expect(ahasendMeta.webhooks).toBe(true);
  });

  it("checks the key pattern", () => {
    const pattern = new RegExp(
      ahasendMeta.credentialFields.find((field) => field.name === "apiKey")?.pattern ?? "",
    );
    expect(pattern.test(KEY)).toBe(true);
    expect(pattern.test("aha-sk-short")).toBe(false);
    expect(pattern.test("re_0123456789012345678901")).toBe(false);
  });

  it("makes createMailer warn about the short window without an idempotency store", () => {
    const credentials = { apiKey: KEY, accountId: ACCOUNT };
    const warn = vi.fn();
    createMailer({ providers: [{ adapter: ahasend(), credentials }], logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("keeps an idempotency key for a short time");
    const quiet = vi.fn();
    createMailer({
      providers: [{ adapter: ahasend(), credentials }],
      namespace: "test",
      idempotency: new MemoryIdempotencyStore(),
      logger: { warn: quiet },
    });
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("ahasend webhooks", () => {
  const hooks = ahasend().webhooks;
  const body = utf8(ahasendEvent("message.delivered"));

  async function signed(at = NOW, secret = SECRET) {
    return signAhasendWebhook({ body, secret, at });
  }

  it("passes a body signed with the raw aha-whsec- secret", async () => {
    const sample = await signed();
    expect(await hooks.verify({ ...sample, secret: SECRET, now: NOW })).toEqual({ ok: true });
  });

  it("refuses the same body signed with the base64-decoded secret or with no prefix", async () => {
    // The fixture secret text after the prefix, read as base64 the way Svix secrets are.
    const rest = SECRET.replace(/^aha-whsec-/, "");
    const decoded = base64ToBytes(rest.replace(/-/g, "+").padEnd(28, "A"));
    expect(decoded).not.toBeNull();
    const timestamp = String(Math.floor(NOW / 1000));
    for (const key of [decoded as Uint8Array, utf8(rest)]) {
      const signature = bytesToBase64(
        await hmacSign(key, ahasendSignedPayload(AHASEND_FIXTURE_DELIVERY_ID, timestamp, body)),
      );
      const headers = new Headers((await signed()).headers);
      headers.set(AHASEND_SIGNATURE_HEADER, `v1,${signature}`);
      expect(await hooks.verify({ headers, body, secret: SECRET, now: NOW })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });

  it("accepts any matching entry of a space-separated list", async () => {
    const sample = await signed();
    const headers = new Headers(sample.headers);
    const good = headers.get(AHASEND_SIGNATURE_HEADER) ?? "";
    const other = `v1,${bytesToBase64(new Uint8Array(32))}`;
    headers.set(AHASEND_SIGNATURE_HEADER, `v2,abc ${other} ${good}`);
    expect(await hooks.verify({ headers, body, secret: SECRET, now: NOW })).toEqual({ ok: true });
  });

  it("gives typed rejections for a stale time, a changed body, and a missing signature", async () => {
    const old = await signed(NOW - 6 * 60 * 1000);
    expect(await hooks.verify({ ...old, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "stale",
    });
    const future = await signed(NOW + 6 * 60 * 1000);
    expect(await hooks.verify({ ...future, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "stale",
    });
    const sample = await signed();
    const changed = utf8(ahasendEvent("message.bounced"));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    const missing = new Headers(sample.headers);
    missing.delete(AHASEND_SIGNATURE_HEADER);
    expect(await hooks.verify({ headers: missing, body, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const broken = new Headers(sample.headers);
    broken.set(AHASEND_TIMESTAMP_HEADER, "soon");
    expect(await hooks.verify({ headers: broken, body, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await hooks.verify({ ...sample, secret: "", now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a signed body that is not one JSON object", async () => {
    const list = utf8("[]");
    const sample = await signAhasendWebhook({ body: list, secret: SECRET, at: NOW });
    expect(await hooks.verify({ ...sample, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("parses the mapped events with the delivery id as the key", async () => {
    const sample = await signed();
    const cases: [string, Record<string, unknown>][] = [
      ["message.delivered", { type: "delivered" }],
      ["message.bounced", { type: "bounced" }],
      ["message.transient_error", { type: "bounced", bounce: "soft" }],
      ["message.complained", { type: "complained" }],
      ["message.failed", { type: "unknown" }],
    ];
    for (const [rawType, expected] of cases) {
      const [event] = parseAhasendEvents("ahasend", utf8(ahasendEvent(rawType)), sample.headers);
      expect(event).toMatchObject({
        ...expected,
        rawType,
        provider: "ahasend",
        eventKey: AHASEND_FIXTURE_DELIVERY_ID,
        recipient: "ana@example.org",
        providerMessageId: AHASEND_FIXTURE_MESSAGE_ID,
        occurredAt: Date.parse("2026-10-27T12:00:00.123Z"),
      });
      if (rawType === "message.bounced") expect(event?.bounce).toBeUndefined();
    }
    expect(parseAhasendEvents("ahasend", utf8("not json"), sample.headers)).toEqual([]);
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const sample = await signAhasendWebhook({
      body: utf8(ahasendEvent("message.transient_error")),
      secret: SECRET,
      at: Date.now(),
    });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/ahasend", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter: ahasend(), secret: SECRET, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "soft" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });
});
