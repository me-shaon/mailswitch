import { describe, expect, it } from "vitest";
import {
  MAILERSEND_FIXTURE_SECRET,
  mailersendEvent,
  signMailersendWebhook,
} from "../../src/conformance/fixtures/mailersend";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import { sha256Hex } from "../../src/internal/sha256";
import {
  MAILERSEND_API_BASE,
  MAILERSEND_SIGNATURE_HEADER,
  mailersend,
} from "../../src/providers/mailersend/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = `${MAILERSEND_API_BASE}/v1/email`;
const QUOTA_URL = `${MAILERSEND_API_BASE}/v1/api-quota`;
const KEY = "mlsn.test-mailersend-token-not-real";
const SECRET = MAILERSEND_FIXTURE_SECRET;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");

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

function accepted(id = "msg-1", headers: Record<string, string> = {}): RecordedExchange {
  return exchange(SEND_URL, 202, { "x-message-id": id, ...headers });
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

const recipients = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}@example.org`);

function warning(type: string) {
  return {
    message: "There are some warnings for your request.",
    warnings: [
      {
        type,
        ...(type === "ALL_SUPPRESSED"
          ? { message: "All of the recipients provided have been suppressed." }
          : { warning: "Some of the recipients have been suppressed." }),
        recipients: [{ email: "ana@example.org", name: "Ana", reasons: ["blocklisted"] }],
      },
    ],
  };
}

describe("mailersend send", () => {
  it("maps a full message with an inline attachment to the documented payload", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([accepted("6892766ae78995a317577aa1")]);
    const result = await mailersend().send(
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
      provider: "mailersend",
      providerMessageId: "6892766ae78995a317577aa1",
    });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      from: { email: "billing@example.com", name: "Acme Billing" },
      to: [{ email: "ana@example.org" }, { email: "bo@example.org", name: "Bo, Jr." }],
      cc: [{ email: "cc@example.org", name: "Cy" }],
      bcc: [{ email: "bcc@example.org" }],
      reply_to: { email: "support@example.com", name: "Support" },
      subject: "Your invoice",
      text: "Invoice attached.",
      html: "<p>Invoice attached.</p>",
      headers: [{ name: "X-Invoice", value: "INV-1" }],
      attachments: [
        { content: bytesToBase64(pdf), filename: "invoice.pdf", disposition: "attachment" },
        {
          content: bytesToBase64(utf8("png")),
          filename: "logo.png",
          disposition: "inline",
          id: "logo",
        },
      ],
    });
  });

  it("sends only the parts that the message has, and no idempotency key", async () => {
    const { mock, ctx } = context([accepted()]);
    await mailersend().send(message({ html: undefined, idempotencyKey: "invoice-1" }), ctx);
    const body = JSON.parse(mock.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.text).toBe("Invoice attached.");
    for (const name of ["html", "cc", "bcc", "reply_to", "headers", "attachments"]) {
      expect(body).not.toHaveProperty(name);
    }
    expect(mock.calls[0]?.body).not.toContain("invoice-1");
    expect([...(mock.calls[0]?.headers.values() ?? [])]).not.toContain("invoice-1");
  });

  it("gives not_sent/rejected for a 202 with ALL_SUPPRESSED and no message id", async () => {
    const { ctx } = context([
      exchange(SEND_URL, 202, { "content-type": "application/json" }, warning("ALL_SUPPRESSED")),
    ]);
    const result = await mailersend().send(message(), ctx);
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "rejected",
      httpStatus: 202,
      provider: "mailersend",
    });
    expect(JSON.stringify(result)).not.toContain("ana@example.org");
  });

  it("gives unknown for ALL_SUPPRESSED that also carries a message id", async () => {
    const { ctx } = context([
      exchange(SEND_URL, 202, { "x-message-id": "m-1" }, warning("ALL_SUPPRESSED")),
    ]);
    expect(await mailersend().send(message(), ctx)).toMatchObject({ status: "unknown" });
  });

  it("gives sent for a 202 with SOME_SUPPRESSED and a message id", async () => {
    const { ctx } = context([
      exchange(SEND_URL, 202, { "x-message-id": "m-2" }, warning("SOME_SUPPRESSED")),
    ]);
    expect(await mailersend().send(message(), ctx)).toEqual({
      status: "sent",
      provider: "mailersend",
      providerMessageId: "m-2",
    });
  });

  it("gives sent for a paused account that returns a message id", async () => {
    const { ctx } = context([accepted("m-3", { "x-send-paused": "true" })]);
    expect(await mailersend().send(message(), ctx)).toEqual({
      status: "sent",
      provider: "mailersend",
      providerMessageId: "m-3",
    });
  });

  it("gives unknown for a 202 with no message id and no warning", async () => {
    for (const body of ["", { message: "ok" }]) {
      const { ctx } = context([exchange(SEND_URL, 202, {}, body)]);
      expect(await mailersend().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        provider: "mailersend",
      });
    }
  });

  it("gives unknown for a 202 body that it cannot read", async () => {
    for (const body of ["not json", { warnings: "odd" }, "[1"]) {
      const { ctx } = context([exchange(SEND_URL, 202, { "x-message-id": "m-4" }, body)]);
      expect(await mailersend().send(message(), ctx)).toMatchObject({ status: "unknown" });
    }
  });

  it("keeps 408, 421, and every 5xx unknown", async () => {
    for (const status of [408, 421, 500, 502, 503, 504]) {
      const { ctx } = context([exchange(SEND_URL, status, {}, { message: "Server Error" })]);
      expect(await mailersend().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        httpStatus: status,
      });
    }
  });

  it("keeps a timeout and a network error unknown", async () => {
    const slow = context([
      { label: "timeout", method: "POST", url: SEND_URL, response: "timeout" },
    ]);
    expect(await mailersend().send(message(), slow.ctx)).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
    const down = context([
      { label: "network", method: "POST", url: SEND_URL, response: "network" },
    ]);
    expect(await mailersend().send(message(), down.ctx)).toMatchObject({
      status: "unknown",
      reason: "network",
    });
  });

  it("maps 400, 401, 403, 404, and 422 and keeps the body out of the result", async () => {
    const cases: [number, string][] = [
      [400, "invalid_message"],
      [401, "auth"],
      [403, "auth"],
      [404, "rejected"],
      [422, "invalid_message"],
    ];
    for (const [status, reason] of cases) {
      const { ctx } = context([
        exchange(SEND_URL, status, {}, { message: "secret-ish body", errors: { to: ["x"] } }),
      ]);
      const result = await mailersend().send(message(), ctx);
      expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: status });
      expect(result.provider).toBe("mailersend");
      expect(JSON.stringify(result)).not.toContain("secret-ish");
    }
  });

  it("refines a 422 from the #MS code", async () => {
    const body = (text: string) => ({
      message: "The given data was invalid.",
      errors: { "from.email": [text] },
    });
    const cases: [string, string][] = [
      [
        "The from.email domain must be verified in your account to send emails. #MS42207",
        "rejected",
      ],
      ["You have reached your email usage limit. #MS42204", "quota"],
      ["Custom headers are available on the Professional plan. #MS42233", "invalid_message"],
      ["No code in this text.", "invalid_message"],
    ];
    for (const [text, reason] of cases) {
      const { ctx } = context([exchange(SEND_URL, 422, {}, body(text))]);
      const result = await mailersend().send(message(), ctx);
      expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: 422 });
      expect(JSON.stringify(result)).not.toContain("verified in your account");
    }
    const broken = context([exchange(SEND_URL, 422, {}, "not json")]);
    expect(await mailersend().send(message(), broken.ctx)).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
    });
  });

  it("reads retryAfterMs of a 429 from retry-after", async () => {
    const { ctx } = context([exchange(SEND_URL, 429, { "retry-after": "30" })]);
    expect(await mailersend().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 30_000,
    });
  });

  it("refuses 51 To, 11 Cc, or 11 Bcc recipients with no request", async () => {
    const cases: Partial<OutgoingMessage>[] = [
      { to: recipients(51, "to") },
      { cc: recipients(11, "cc") },
      { bcc: recipients(11, "bcc") },
    ];
    for (const overrides of cases) {
      const { mock, ctx } = context([accepted()]);
      expect(await mailersend().send(message(overrides), ctx)).toMatchObject({
        status: "not_sent",
        reason: "unsupported",
        provider: "mailersend",
      });
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("sends 50 To, 10 Cc, and 10 Bcc recipients", async () => {
    const { mock, ctx } = context([accepted()]);
    const result = await mailersend().send(
      message({ to: recipients(50, "to"), cc: recipients(10, "cc"), bcc: recipients(10, "bcc") }),
      ctx,
    );
    expect(result).toMatchObject({ status: "sent" });
    expect(mock.calls).toHaveLength(1);
  });

  it("uses the option key and baseUrl, and throws a TypeError for invalid options", async () => {
    const mock = mockFetch([
      exchange("http://localhost:8787/v1/email", 202, { "x-message-id": "x" }),
    ]);
    const ctx: SendContext = { fetch: mock.fetch, timeoutMs: 5_000, credentials: {}, now: NOW };
    const adapter = mailersend({ baseUrl: "http://localhost:8787/", apiKey: KEY });
    expect(await adapter.send(message(), ctx)).toMatchObject({ status: "sent" });
    expect(mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(() => mailersend({ baseUrl: "http://api.mailersend.com" })).toThrow(TypeError);
    expect(() => mailersend({ apiKey: 1 as unknown as string })).toThrow(TypeError);
    expect(() => mailersend(null as unknown as object)).toThrow(TypeError);
  });
});

describe("mailersend verify", () => {
  it("is ok for a 200 from the quota endpoint", async () => {
    const { mock, ctx } = context([
      exchange(QUOTA_URL, 200, {}, { quota: 100, remaining: 99, reset: "x" }, "GET"),
    ]);
    expect(await mailersend().verify(ctx)).toEqual({ ok: true });
    expect(mock.calls[0]?.method).toBe("GET");
    expect(mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("is not_sent/auth for a 401 and a 403, and unknown for a 5xx", async () => {
    for (const status of [401, 403]) {
      const { ctx } = context([exchange(QUOTA_URL, status, {}, { message: "no" }, "GET")]);
      expect(await mailersend().verify(ctx)).toMatchObject({
        ok: false,
        status: "not_sent",
        reason: "auth",
        provider: "mailersend",
      });
    }
    const down = context([exchange(QUOTA_URL, 503, {}, "", "GET")]);
    expect(await mailersend().verify(down.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });
});

describe("mailersend webhooks", () => {
  const hooks = mailersend().webhooks;
  const DELIVERED = JSON.stringify(mailersendEvent("activity.delivered"));

  const signed = (body: string, secret = SECRET) =>
    signMailersendWebhook({ body: utf8(body), secret });
  const input = (sample: { headers: Headers; body: Uint8Array }, secret = SECRET) => ({
    headers: sample.headers,
    body: sample.body,
    secret,
    now: NOW,
  });

  it("accepts a signed body and maps each documented type", async () => {
    const cases: [string, string, string | undefined][] = [
      ["activity.delivered", "delivered", undefined],
      ["activity.hard_bounced", "bounced", "hard"],
      ["activity.soft_bounced", "bounced", "soft"],
      ["activity.spam_complaint", "complained", undefined],
      ["activity.spam_complaints", "complained", undefined],
      ["activity.unsubscribed", "unsubscribed", undefined],
      ["activity.opened", "unknown", undefined],
      ["maintenance.start", "unknown", undefined],
    ];
    for (const [rawType, type, bounce] of cases) {
      const sample = await signed(JSON.stringify(mailersendEvent(rawType)));
      expect(await hooks.verify(input(sample))).toEqual({ ok: true });
      const events = hooks.parse(sample.body, sample.headers);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type, rawType, provider: "mailersend" });
      expect(events[0]?.bounce).toBe(bounce);
    }
  });

  it("accepts an upper-case hex signature", async () => {
    const sample = await signed(DELIVERED);
    const headers = new Headers(sample.headers);
    headers.set(
      MAILERSEND_SIGNATURE_HEADER,
      (headers.get(MAILERSEND_SIGNATURE_HEADER) ?? "").toUpperCase(),
    );
    expect(await hooks.verify(input({ headers, body: sample.body }))).toEqual({ ok: true });
  });

  it("refuses a changed body, a wrong secret, a missing header, and an empty secret", async () => {
    const sample = await signed(DELIVERED);
    const changed = { headers: sample.headers, body: utf8(DELIVERED.replace("ana", "eve")) };
    expect(await hooks.verify(input(changed))).toEqual({ ok: false, reason: "bad_signature" });
    expect(await hooks.verify(input(sample, "another-signing-secret-0123456789"))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const unsigned = new Headers(sample.headers);
    unsigned.delete(MAILERSEND_SIGNATURE_HEADER);
    expect(await hooks.verify(input({ headers: unsigned, body: sample.body }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await hooks.verify(input(sample, ""))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signature that is not hex, and a signed body that is not an object", async () => {
    const sample = await signed(DELIVERED);
    const broken = new Headers(sample.headers);
    broken.set(MAILERSEND_SIGNATURE_HEADER, "sha256=abc");
    expect(await hooks.verify(input({ headers: broken, body: sample.body }))).toEqual({
      ok: false,
      reason: "malformed",
    });
    for (const body of ["[1,2]", "null", "not json"]) {
      expect(await hooks.verify(input(await signed(body)))).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("reads the fields of the event, and of the older nested shape", () => {
    const [flat] = hooks.parse(utf8(DELIVERED), new Headers());
    expect(flat).toMatchObject({
      eventKey: "act-delivered-0001",
      recipient: "ana@example.org",
      providerMessageId: "6892766ae78995a317577aa1",
      occurredAt: Date.parse("2026-10-27T11:59:54.000Z"),
    });
    const nested = utf8(
      JSON.stringify({
        type: "activity.delivered",
        created_at: "2026-10-27T11:00:00.000000Z",
        data: {
          id: "act-nested-1",
          email: { message: { id: "msg-nested" }, recipient: { email: "cy@example.org" } },
        },
      }),
    );
    expect(hooks.parse(nested, new Headers())[0]).toMatchObject({
      eventKey: "act-nested-1",
      recipient: "cy@example.org",
      providerMessageId: "msg-nested",
    });
  });

  it("keys an event with no data.id by the SHA-256 of the body", () => {
    const body = utf8(JSON.stringify({ type: "activity.delivered", data: {} }));
    expect(hooks.parse(body, new Headers())).toEqual([
      {
        type: "delivered",
        provider: "mailersend",
        eventKey: sha256Hex(body),
        rawType: "activity.delivered",
      },
    ]);
    expect(hooks.parse(utf8("[]"), new Headers())).toEqual([]);
  });

  it("is marked as needing a dedupe store and signs no timestamp", () => {
    expect(mailersend().requiresDedupe).toBe(true);
    expect(mailersend().webhooks.signedTimestamp).toBe(false);
  });

  it("drops a replay of one event through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = mailersend();
    const sample = await signed(DELIVERED);
    const deliver = () =>
      handleWebhook(
        new Request("https://app.example.com/webhooks/mailersend", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: SECRET, dedupe, now: () => NOW },
      );
    const first = await deliver();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "delivered" }]);
    await first.ack();
    expect(await deliver()).toMatchObject({ ok: true, events: [] });
  });
});

describe("mailersend unsubscribe", () => {
  it("maps activity.unsubscribed to unsubscribed with the recipient and message id", () => {
    const body = mailersendEvent("activity.unsubscribed", { recipient: "bo@example.org" });
    const events = mailersend().webhooks?.parse(utf8(JSON.stringify(body)), new Headers()) ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unsubscribed",
      recipient: "bo@example.org",
      providerMessageId: "6892766ae78995a317577aa1",
      rawType: "activity.unsubscribed",
      eventKey: "act-unsubscribed-0001",
    });
  });

  it("reads the recipient and message id from the older nested shape", () => {
    const body = {
      type: "activity.unsubscribed",
      created_at: "2026-10-27T11:59:54.000000Z",
      data: {
        id: "act-unsub-0002",
        type: "unsubscribed",
        email: {
          message: { id: "6892766ae78995a317577aa1" },
          recipient: { email: "cy@example.org" },
        },
        morph: { object: "unsubscribe", reason: "NO_LONGER_WANT" },
      },
    };
    const events = mailersend().webhooks?.parse(utf8(JSON.stringify(body)), new Headers()) ?? [];
    expect(events[0]).toMatchObject({
      type: "unsubscribed",
      recipient: "cy@example.org",
      providerMessageId: "6892766ae78995a317577aa1",
    });
  });
});
