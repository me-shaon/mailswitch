import { describe, expect, it } from "vitest";
import {
  SMTP2GO_BAD_KEY,
  SMTP2GO_FIXTURE_KEY,
  SMTP2GO_FIXTURE_SECRET,
  SMTP2GO_INVALID_SENDER,
  SMTP2GO_MISSING_KEY,
  signSmtp2goWebhook,
  smtp2goAnswer,
  smtp2goError,
  smtp2goEvent,
} from "../../src/conformance/fixtures/smtp2go";
import {
  type CapturedRequest,
  mockFetch,
  type RecordedExchange,
  type RecordedHttpResponse,
} from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import { createMailer } from "../../src/core/pipeline";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  generateSmtp2goWebhookSecret,
  parseSmtp2goEvents,
  SMTP2GO_REGIONS,
  smtp2go,
  smtp2goWebhookAuth,
} from "../../src/providers/smtp2go/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const BASE = SMTP2GO_REGIONS.global;
const SEND_URL = `${BASE}/v3/email/send`;
const PERMISSIONS_URL = `${BASE}/v3/api_keys/permissions`;
const KEY = SMTP2GO_FIXTURE_KEY;
const HOOK_SECRET = SMTP2GO_FIXTURE_SECRET;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");

function context(
  exchanges: RecordedExchange[],
  credentials: Record<string, string> = { apiKey: KEY },
) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = { fetch: mock.fetch, timeoutMs: 5_000, credentials, now: NOW };
  return { mock, ctx };
}

function answer(
  response: RecordedHttpResponse | ((request: CapturedRequest) => RecordedHttpResponse),
  url = SEND_URL,
): RecordedExchange {
  return { label: `POST ${url}`, method: "POST", url, response };
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

const sentBody = (mock: { calls: CapturedRequest[] }, index = 0) =>
  JSON.parse(mock.calls[index]?.body ?? "{}") as Record<string, unknown>;

const permissions = (data: unknown): RecordedHttpResponse => ({
  status: 200,
  body: { request_id: "f3e50113-deb2-4e54-9675-2ea497c3732e", data },
});

describe("smtp2go send", () => {
  it("maps a full message to the documented payload and reads email_id", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([answer(smtp2goAnswer(1))]);
    const result = await smtp2go().send(
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
      provider: "smtp2go",
      providerMessageId: "1u0SwL-B9zBpi9ffUq-JAB2",
    });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("x-smtp2go-api-key")).toBe(KEY);
    expect(call?.headers.get("authorization")).toBeNull();
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.body).not.toContain(KEY);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      sender: "Acme Billing <billing@example.com>",
      to: ["ana@example.org", '"Bo, Jr." <bo@example.org>'],
      cc: ["Cy <cc@example.org>"],
      bcc: ["bcc@example.org"],
      subject: "Your invoice",
      text_body: "Invoice attached.",
      html_body: "<p>Invoice attached.</p>",
      custom_headers: [
        { header: "X-Invoice", value: "INV-1" },
        { header: "Reply-To", value: "Support <support@example.com>" },
      ],
      attachments: [
        { filename: "invoice.pdf", fileblob: bytesToBase64(pdf), mimetype: "application/pdf" },
      ],
      inlines: [{ filename: "logo", fileblob: bytesToBase64(utf8("png")), mimetype: "image/png" }],
      fastaccept: false,
    });
  });

  it("sends only the parts that the message has, and always fastaccept false", async () => {
    const { mock, ctx } = context([answer(smtp2goAnswer(1))]);
    await smtp2go().send(message({ html: undefined, idempotencyKey: "invoice-1" }), ctx);
    const body = sentBody(mock);
    expect(body.fastaccept).toBe(false);
    expect(body.text_body).toBe("Invoice attached.");
    for (const name of ["html_body", "cc", "bcc", "custom_headers", "attachments", "inlines"]) {
      expect(body[name]).toBeUndefined();
    }
    expect(mock.calls[0]?.body).not.toContain("invoice-1");
  });

  it("takes the key from the options when the context has none", async () => {
    const { mock, ctx } = context([answer(smtp2goAnswer(1))], {});
    await smtp2go({ apiKey: KEY }).send(message(), ctx);
    expect(mock.calls[0]?.headers.get("x-smtp2go-api-key")).toBe(KEY);
  });

  it("is sent when succeeded > 0, even when failed > 0", async () => {
    const { ctx } = context([answer(smtp2goAnswer(2, 1, ["bad@example.org: refused"]))]);
    expect(await smtp2go().send(message(), ctx)).toMatchObject({
      status: "sent",
      providerMessageId: "1u0SwL-B9zBpi9ffUq-JAB2",
    });
  });

  it("is sent with no id when succeeded > 0 and email_id is missing", async () => {
    const { ctx } = context([answer(smtp2goAnswer(1, 0, [], null))]);
    expect(await smtp2go().send(message(), ctx)).toEqual({ status: "sent", provider: "smtp2go" });
  });

  it("is not_sent/rejected when succeeded is 0 and failed > 0, and never copies failures", async () => {
    const failure = "ana@example.org: the recipient is on the suppression list";
    const { ctx } = context([answer(smtp2goAnswer(0, 1, [failure], null))]);
    const result = await smtp2go().send(message(), ctx);
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "rejected",
      httpStatus: 200,
      provider: "smtp2go",
    });
    expect(JSON.stringify(result)).not.toContain("suppression");
  });

  it("is unknown for a 200 with no counts, zero counts, or no JSON", async () => {
    for (const body of [
      { request_id: "r", data: { email_id: "x" } },
      { request_id: "r", data: { succeeded: 0, failed: 0 } },
      { request_id: "r", data: { succeeded: "1", failed: 0 } },
      "not json",
      "",
    ]) {
      const { ctx } = context([answer({ status: 200, body })]);
      expect(await smtp2go().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        httpStatus: 200,
      });
    }
  });

  it("maps a 400 for a wrong key to not_sent/auth and never copies the error text", async () => {
    const { ctx } = context([answer(SMTP2GO_BAD_KEY)]);
    const result = await smtp2go().send(message(), ctx);
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "auth",
      httpStatus: 400,
      provider: "smtp2go",
    });
    expect(result.status !== "sent" && result.message).toContain("API_EXCEPTION");
    expect(JSON.stringify(result)).not.toContain("API User");
  });

  it("maps a 400 ENDPOINT_PERMISSION_DENIED to auth and a 403 missing key to auth", async () => {
    const denied = smtp2goError(
      400,
      "E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED",
      "You do not have permission to access this API endpoint",
    );
    for (const response of [denied, SMTP2GO_MISSING_KEY]) {
      const { ctx } = context([answer(response)]);
      expect(await smtp2go().send(message(), ctx)).toMatchObject({
        status: "not_sent",
        reason: "auth",
      });
    }
  });

  it("keeps other 400 answers invalid_message", async () => {
    const otherException = smtp2goError(
      400,
      "E_ApiResponseCodes.API_EXCEPTION",
      "The sender domain is not verified",
    );
    for (const response of [
      SMTP2GO_INVALID_SENDER,
      otherException,
      { status: 400, body: "Bad Request" },
      smtp2goError(400, "<script>", "the 'api_key' is odd"),
    ]) {
      const { ctx } = context([answer(response)]);
      const result = await smtp2go().send(message(), ctx);
      expect(result).toMatchObject({ status: "not_sent", reason: "invalid_message" });
      expect(JSON.stringify(result)).not.toContain("script");
    }
  });

  it("maps 401, 402, and 404", async () => {
    const cases: [number, string][] = [
      [401, "auth"],
      [402, "rejected"],
      [404, "rejected"],
    ];
    for (const [status, reason] of cases) {
      const { ctx } = context([answer(smtp2goError(status, "E_ApiResponseCodes.X", "x"))]);
      expect(await smtp2go().send(message(), ctx)).toMatchObject({ status: "not_sent", reason });
    }
  });

  it("gives a 429 rate_limited with retryAfterMs 60000, or the Retry-After header", async () => {
    const plain = context([answer({ status: 429, body: "" })]);
    expect(await smtp2go().send(message(), plain.ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 60_000,
    });
    const header = context([answer({ status: 429, headers: { "retry-after": "5" }, body: "" })]);
    expect(await smtp2go().send(message(), header.ctx)).toMatchObject({ retryAfterMs: 5_000 });
  });

  it("keeps 500 and 503 unknown", async () => {
    for (const status of [500, 503]) {
      const { ctx } = context([answer({ status, body: "" })]);
      expect(await smtp2go().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
      });
    }
  });

  it("refuses 101 addresses in one field with no request, and allows 100 per field", async () => {
    const list = (n: number, field: string) =>
      Array.from({ length: n }, (_, i) => `${field}${i}@example.org`);
    for (const field of ["to", "cc", "bcc"] as const) {
      const { mock, ctx } = context([answer(smtp2goAnswer(1))]);
      const result = await smtp2go().send(message({ [field]: list(101, field) }), ctx);
      expect(result).toMatchObject({
        status: "not_sent",
        reason: "unsupported",
        provider: "smtp2go",
      });
      expect(mock.calls).toHaveLength(0);
    }
    const { mock, ctx } = context([answer(smtp2goAnswer(1))]);
    const full = message({ to: list(100, "t"), cc: list(100, "c"), bcc: list(100, "b") });
    expect((await smtp2go().send(full, ctx)).status).toBe("sent");
    expect(mock.calls).toHaveLength(1);
  });

  it("refuses an invalid message with no request", async () => {
    const { mock, ctx } = context([answer(smtp2goAnswer(1))]);
    const result = await smtp2go().send(message({ to: ["not-an-address"] }), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "invalid_message" });
    expect(mock.calls).toHaveLength(0);
  });

  it("sends to the host of the region option", async () => {
    for (const region of ["us", "eu", "au"] as const) {
      const url = `https://${region}-api.smtp2go.com/v3/email/send`;
      const { mock, ctx } = context([answer(smtp2goAnswer(1), url)]);
      expect((await smtp2go({ region }).send(message(), ctx)).status).toBe("sent");
      expect(mock.calls[0]?.url).toBe(url);
    }
  });

  it("sends to the baseUrl option, which replaces the region", async () => {
    const url = "https://proxy.example.com/v3/email/send";
    const { mock, ctx } = context([answer(smtp2goAnswer(1), url)]);
    await smtp2go({ region: "eu", baseUrl: "https://proxy.example.com/" }).send(message(), ctx);
    expect(mock.calls[0]?.url).toBe(url);
  });

  it("refuses invalid options", () => {
    expect(() => smtp2go({ region: "uk" as "us" })).toThrow(TypeError);
    expect(() => smtp2go({ baseUrl: "http://api.smtp2go.com" })).toThrow(TypeError);
    expect(() => smtp2go({ baseUrl: "https://user:pass@api.smtp2go.com" })).toThrow(TypeError);
    expect(() => smtp2go({ apiKey: 1 as unknown as string })).toThrow(TypeError);
    expect(() => smtp2go({ previousWebhookSecret: "short" })).toThrow(TypeError);
    expect(() => smtp2go({ webhookUsername: "a:b" })).toThrow(TypeError);
    expect(() => smtp2go(null as unknown as object)).toThrow(TypeError);
  });

  it("keeps a timeout and a network error unknown", async () => {
    for (const response of ["timeout", "network"] as const) {
      const { ctx } = context([answer(response as unknown as RecordedHttpResponse)]);
      expect(await smtp2go().send(message(), ctx)).toMatchObject({ status: "unknown" });
    }
  });

  it("goes through the mailer with one request per message", async () => {
    const mock = mockFetch([answer(smtp2goAnswer(1))]);
    const mailer = createMailer({
      providers: [{ adapter: smtp2go(), credentials: { apiKey: KEY } }],
      fetch: mock.fetch,
      now: () => NOW,
      logger: { warn: () => {} },
    });
    const results = await mailer.sendBatch([message(), message({ to: ["bo@example.org"] })]);
    expect(mock.calls).toHaveLength(2);
    expect(results.every((result) => result.status === "sent")).toBe(true);
  });
});

describe("smtp2go verify", () => {
  it("is ok when the permission list has /email/send, and sends POST {}", async () => {
    const { mock, ctx } = context([
      answer(permissions(["/email/send", "/api_keys/view"]), PERMISSIONS_URL),
    ]);
    expect(await smtp2go().verify(ctx)).toEqual({ ok: true });
    expect(mock.calls[0]?.method).toBe("POST");
    expect(mock.calls[0]?.body).toBe("{}");
    expect(mock.calls[0]?.headers.get("x-smtp2go-api-key")).toBe(KEY);
  });

  it("is not_sent/auth for a list without /email/send", async () => {
    const { ctx } = context([answer(permissions(["/api_keys/view"]), PERMISSIONS_URL)]);
    expect(await smtp2go().verify(ctx)).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
  });

  it("maps a wrong key to auth, a 503 to unknown, and an unreadable 200 to unknown", async () => {
    const bad = context([answer(SMTP2GO_BAD_KEY, PERMISSIONS_URL)]);
    expect(await smtp2go().verify(bad.ctx)).toMatchObject({ ok: false, reason: "auth" });
    const down = context([answer({ status: 503, body: "" }, PERMISSIONS_URL)]);
    expect(await smtp2go().verify(down.ctx)).toMatchObject({ ok: false, status: "unknown" });
    const odd = context([answer({ status: 200, body: { data: {} } }, PERMISSIONS_URL)]);
    expect(await smtp2go().verify(odd.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });
});

describe("smtp2go webhooks", () => {
  const hooks = smtp2go().webhooks;
  const verify = (headers: Headers, body: Uint8Array, secret = HOOK_SECRET) =>
    hooks.verify({ headers, body, secret, now: NOW });
  const basic = (secret: string, user = "mailswitch") =>
    new Headers({ authorization: `Basic ${bytesToBase64(utf8(`${user}:${secret}`))}` });

  it("passes the Bearer header and parses a JSON event", async () => {
    const body = utf8(JSON.stringify(smtp2goEvent("bounce", { bounce: "soft" })));
    const sample = await signSmtp2goWebhook({ body, secret: HOOK_SECRET });
    expect(await verify(sample.headers, sample.body)).toEqual({ ok: true });
    expect(hooks.parse(sample.body, sample.headers)).toEqual([
      {
        type: "bounced",
        bounce: "soft",
        provider: "smtp2go",
        eventKey:
          "b1c2d3e4f5a6-bounce:bounce:1u0SwL-B9zBpi9ffUq-JAB2:ana@example.org:2026-10-27T11:59:30Z",
        rawType: "bounce",
        recipient: "ana@example.org",
        providerMessageId: "1u0SwL-B9zBpi9ffUq-JAB2",
        occurredAt: Date.parse("2026-10-27T11:59:30Z"),
      },
    ]);
  });

  it("passes a Basic header with the username, in any scheme case", async () => {
    const body = utf8(JSON.stringify(smtp2goEvent("delivered")));
    expect(await verify(basic(HOOK_SECRET), body)).toEqual({ ok: true });
    const lower = new Headers({ authorization: `bearer ${HOOK_SECRET}` });
    expect(await verify(lower, body)).toEqual({ ok: true });
    expect(await verify(basic(HOOK_SECRET, "other"), body)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a wrong token, a missing header, another scheme, and an empty secret", async () => {
    const body = utf8(JSON.stringify(smtp2goEvent("delivered")));
    const wrong = new Headers({ authorization: `Bearer ${HOOK_SECRET}x` });
    expect(await verify(wrong, body)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify(new Headers(), body)).toEqual({ ok: false, reason: "bad_signature" });
    const digest = new Headers({ authorization: `Digest ${HOOK_SECRET}` });
    expect(await verify(digest, body)).toEqual({ ok: false, reason: "bad_signature" });
    const right = new Headers({ authorization: `Bearer ${HOOK_SECRET}` });
    expect(await verify(right, body, "")).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a form-encoded body and other bodies that are not JSON events", async () => {
    const headers = new Headers({ authorization: `Bearer ${HOOK_SECRET}` });
    const form = "event=delivered&rcpt=ana%40example.org&id=b1c2d3e4f5a6";
    for (const text of [form, "[]", "[1]", "null", '"delivered"', "{"]) {
      expect(await verify(headers, utf8(text))).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses a weak secret as invalid_secret, which is a setup error", async () => {
    const headers = new Headers({ authorization: "Bearer short" });
    expect(await verify(headers, utf8("{}"), "short")).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
  });

  it("accepts the previous secret during a rotation", async () => {
    const previous = generateSmtp2goWebhookSecret();
    const rotated = smtp2go({ previousWebhookSecret: previous }).webhooks;
    const body = utf8(JSON.stringify(smtp2goEvent("delivered")));
    for (const secret of [previous, HOOK_SECRET]) {
      const headers = new Headers({ authorization: `Bearer ${secret}` });
      expect(await rotated.verify({ headers, body, secret: HOOK_SECRET, now: NOW })).toEqual({
        ok: true,
      });
    }
  });

  it("maps the events and keys, and keeps a repeated id once", () => {
    const text = JSON.stringify([
      smtp2goEvent("delivered"),
      smtp2goEvent("bounce", { bounce: "hard" }),
      smtp2goEvent("bounce", { id: "x-2" }),
      smtp2goEvent("spam"),
      smtp2goEvent("reject"),
      smtp2goEvent("delivered"),
      { time: 1, rcpt: "a@example.org" },
    ]);
    const events = parseSmtp2goEvents("smtp2go", utf8(text));
    expect(events.map((event) => [event.type, event.bounce, event.rawType])).toEqual([
      ["delivered", undefined, "delivered"],
      ["bounced", "hard", "bounce"],
      ["bounced", undefined, "bounce"],
      ["complained", undefined, "spam"],
      ["unknown", undefined, "reject"],
    ]);
    expect(parseSmtp2goEvents("smtp2go", utf8("event=delivered"))).toEqual([]);
  });

  it("adds the event fields to an id that two events share", () => {
    const text = JSON.stringify([
      smtp2goEvent("delivered", { id: "hook-1" }),
      smtp2goEvent("bounce", { id: "hook-1" }),
      smtp2goEvent("delivered", { id: "hook-1", rcpt: "ben@example.org" }),
      smtp2goEvent("delivered", { id: "hook-1" }),
    ]);
    const keys = parseSmtp2goEvents("smtp2go", utf8(text)).map((event) => event.eventKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    const again = parseSmtp2goEvents(
      "smtp2go",
      utf8(JSON.stringify(smtp2goEvent("delivered", { id: "hook-1" }))),
    );
    expect(again[0]?.eventKey).toBe(keys[0]);
  });

  it("builds a key with no id, and reads a Unix time", () => {
    const text = JSON.stringify({
      event: "open",
      email_id: "e-1",
      rcpt: "Ana@Example.org",
      time: 1793102394,
    });
    expect(parseSmtp2goEvents("smtp2go", utf8(text))).toEqual([
      {
        type: "unknown",
        provider: "smtp2go",
        rawType: "open",
        eventKey: ":open:e-1:ana@example.org:1793102394",
        recipient: "Ana@Example.org",
        providerMessageId: "e-1",
        occurredAt: 1793102394000,
      },
    ]);
  });

  it("gives the auth fields for the webhook API", () => {
    expect(smtp2goWebhookAuth(HOOK_SECRET)).toEqual({
      auth_header_type: "bearer",
      auth_header_value: HOOK_SECRET,
    });
    expect(smtp2goWebhookAuth(HOOK_SECRET, "basic", "hooks")).toEqual({
      auth_header_type: "basic",
      auth_header_value: bytesToBase64(utf8(`hooks:${HOOK_SECRET}`)),
    });
    expect(() => smtp2goWebhookAuth("short")).toThrow(TypeError);
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = smtp2go();
    const body = utf8(JSON.stringify(smtp2goEvent("bounce", { bounce: "hard" })));
    const sample = await signSmtp2goWebhook({ body, secret: HOOK_SECRET });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/smtp2go", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: HOOK_SECRET, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "hard" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });
});

describe("smtp2go unsubscribe", () => {
  it("maps unsubscribe to unsubscribed with the recipient and message id", () => {
    const body = JSON.stringify(smtp2goEvent("unsubscribe", { rcpt: "bo@example.org" }));
    const events = parseSmtp2goEvents("smtp2go", utf8(body));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unsubscribed",
      rawType: "unsubscribe",
      recipient: "bo@example.org",
      providerMessageId: "1u0SwL-B9zBpi9ffUq-JAB2",
    });
  });

  it("keeps resubscribe as unknown", () => {
    const body = JSON.stringify(smtp2goEvent("resubscribe"));
    const events = parseSmtp2goEvents("smtp2go", utf8(body));
    expect(events[0]).toMatchObject({ type: "unknown", rawType: "resubscribe" });
  });
});
