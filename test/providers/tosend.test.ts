import { describe, expect, it } from "vitest";
import { toSendBounce, toSendComplaint } from "../../src/conformance/fixtures/tosend";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  requiresDedupe,
  TOSEND_API_BASE,
  toSendSignature,
  tosend,
} from "../../src/providers/tosend/index";

const SEND_URL = `${TOSEND_API_BASE}/v2/emails`;
const SECRET = "tosend-webhook-secret-0123456789";
const NOW = Date.parse("2026-10-26T12:00:30.000Z");

function context(exchanges: RecordedExchange[]) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = {
    fetch: mock.fetch,
    timeoutMs: 5_000,
    credentials: { apiKey: "tsend_test0123456789" },
    now: NOW,
  };
  return { mock, ctx };
}

function sendExchange(status: number, body: unknown): RecordedExchange {
  return { label: `send ${status}`, method: "POST", url: SEND_URL, response: { status, body } };
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

async function signed(body: string, secret = SECRET) {
  const bytes = utf8(body);
  return {
    headers: new Headers({ "x-tosend-signature": await toSendSignature(secret, bytes) }),
    body: bytes,
  };
}

describe("tosend send", () => {
  it("maps a PDF to the toSend shape and returns sent with message_id", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([sendExchange(200, { message_id: "0100019a-tosend-1" })]);
    const result = await tosend().send(
      message({
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
      provider: "tosend",
      providerMessageId: "0100019a-tosend-1",
    });
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call?.headers.get("authorization")).toBe("Bearer tsend_test0123456789");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      from: { email: "billing@example.com", name: "Acme Billing" },
      to: [{ email: "ana@example.org" }],
      cc: [{ email: "cc@example.org", name: "Cy" }],
      bcc: [{ email: "bcc@example.org" }],
      reply_to: { email: "support@example.com", name: "Support" },
      subject: "Your invoice",
      html: "<p>Invoice attached.</p>",
      text: "Invoice attached.",
      headers: { "X-Invoice": "INV-1" },
      attachments: [
        { type: "application/pdf", name: "invoice.pdf", content: bytesToBase64(pdf) },
        {
          type: "image/png",
          name: "logo.png",
          content: bytesToBase64(utf8("png")),
          content_id: "logo",
        },
      ],
    });
  });

  it("sends no idempotency key, because toSend has none", async () => {
    const { mock, ctx } = context([sendExchange(200, { message_id: "m1" })]);
    await tosend().send(message({ idempotencyKey: "invoice-1" }), ctx);
    expect([...(mock.calls[0]?.headers.values() ?? [])]).not.toContain("invoice-1");
  });

  it("gives not_sent/credits for a 403 about credits", async () => {
    const { ctx } = context([
      sendExchange(403, {
        status_code: 403,
        message: "Insufficient credit balance",
        errors: { credit_balance: "2", current_usage: "0", available: "2" },
      }),
    ]);
    const result = await tosend().send(message(), ctx);
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "credits",
      httpStatus: 403,
      provider: "tosend",
    });
    expect(JSON.stringify(result)).not.toContain("Insufficient");
  });

  it("keeps a 403 without a credits message as not_sent/auth", async () => {
    const { ctx } = context([sendExchange(403, { status_code: 403, message: "Forbidden" })]);
    expect(await tosend().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "auth",
    });
  });

  it("gives not_sent/invalid_message for a 422 unverified domain", async () => {
    const { ctx } = context([
      sendExchange(422, { status_code: 422, message: "Domain example.com is not verified" }),
    ]);
    const result = await tosend().send(message(), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "invalid_message" });
    expect(JSON.stringify(result)).not.toContain("verified");
  });

  it("keeps a 5xx unknown", async () => {
    const { ctx } = context([sendExchange(503, "Service Unavailable")]);
    expect(await tosend().send(message(), ctx)).toMatchObject({
      status: "unknown",
      reason: "provider_error",
    });
  });

  it("refuses 11 MB of encoded attachments with zero network calls", async () => {
    const { mock, ctx } = context([sendExchange(200, { message_id: "m1" })]);
    // 8.25 MB of bytes is 11 MB after base64 encoding.
    const big = new Uint8Array(8_250_000);
    const result = await tosend().send(
      message({
        attachments: [{ filename: "big.pdf", content: big, contentType: "application/pdf" }],
      }),
      ctx,
    );
    expect(result).toMatchObject({ status: "not_sent", reason: "unsupported" });
    expect(mock.calls).toHaveLength(0);
  });

  it("uses the apiKey option and the baseUrl option", async () => {
    const mock = mockFetch([
      {
        label: "send",
        method: "POST",
        url: "https://proxy.example.com/v2/emails",
        response: { status: 200, body: { message_id: "m1" } },
      },
    ]);
    const adapter = tosend({ apiKey: "tsend_option", baseUrl: "https://proxy.example.com/" });
    const result = await adapter.send(message(), {
      fetch: mock.fetch,
      timeoutMs: 5_000,
      credentials: {},
      now: NOW,
    });
    expect(result.status).toBe("sent");
    expect(mock.calls[0]?.headers.get("authorization")).toBe("Bearer tsend_option");
  });
});

describe("tosend sendBatch", () => {
  const BATCH_URL = `${TOSEND_API_BASE}/v2/emails/batch`;

  it("maps a 207 to one result per message, in order", async () => {
    const { mock, ctx } = context([
      {
        label: "207 batch",
        method: "POST",
        url: BATCH_URL,
        response: {
          status: 207,
          body: {
            results: [
              { status: "success", message_id: "m1" },
              { status: "error", status_code: 422, message: "The to field is invalid." },
              { status: "spam", message: "The content looks like spam." },
            ],
          },
        },
      },
    ]);
    const results = await tosend().sendBatch?.(
      [message(), message({ subject: "Second" }), message({ subject: "Third" })],
      ctx,
    );
    expect(results?.map((item) => [item.status, "reason" in item ? item.reason : null])).toEqual([
      ["sent", null],
      ["not_sent", "invalid_message"],
      ["not_sent", "rejected"],
    ]);
    const body = JSON.parse(mock.calls[0]?.body ?? "{}") as { emails: unknown[] };
    expect(body.emails).toHaveLength(3);
  });

  it("refuses an invalid message locally and batches the rest", async () => {
    const { mock, ctx } = context([
      {
        label: "200 batch",
        method: "POST",
        url: BATCH_URL,
        response: { status: 200, body: { results: [{ status: "success", message_id: "m1" }] } },
      },
    ]);
    const results = await tosend().sendBatch?.(
      [message({ to: ["not-an-address"] }), message()],
      ctx,
    );
    expect(results?.map((item) => item.status)).toEqual(["not_sent", "sent"]);
    const body = JSON.parse(mock.calls[0]?.body ?? "{}") as { emails: unknown[] };
    expect(body.emails).toHaveLength(1);
  });

  it("gives every message the batch failure, and unknown for a missing entry", async () => {
    const credits = context([
      {
        label: "403",
        method: "POST",
        url: BATCH_URL,
        response: { status: 403, body: { message: "Insufficient credit balance" } },
      },
    ]);
    const failed = await tosend().sendBatch?.([message(), message()], credits.ctx);
    expect(failed?.map((item) => ("reason" in item ? item.reason : null))).toEqual([
      "credits",
      "credits",
    ]);
    const short = context([
      {
        label: "200 short",
        method: "POST",
        url: BATCH_URL,
        response: { status: 200, body: { results: [{ status: "success", message_id: "m1" }] } },
      },
    ]);
    const partial = await tosend().sendBatch?.([message(), message()], short.ctx);
    expect(partial?.map((item) => item.status)).toEqual(["sent", "unknown"]);
  });
});

describe("tosend verify", () => {
  it("calls GET /v2/info and sends no email", async () => {
    const { mock, ctx } = context([
      {
        label: "info",
        method: "GET",
        url: `${TOSEND_API_BASE}/v2/info`,
        response: { status: 200, body: { account: { status: "active" } } },
      },
    ]);
    expect(await tosend().verify(ctx)).toEqual({ ok: true });
    expect(mock.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${TOSEND_API_BASE}/v2/info`,
    ]);
  });
});

describe("tosend webhooks", () => {
  const hooks = tosend().webhooks;

  it("marks that the webhook router needs a dedupe store", () => {
    expect(requiresDedupe).toBe(true);
    expect(tosend().requiresDedupe).toBe(true);
  });

  it("verifies a valid signature and parses a bounce and a complaint", async () => {
    const bounce = await signed(toSendBounce("ana@example.org"));
    expect(await hooks.verify({ ...bounce, secret: SECRET, now: NOW })).toEqual({ ok: true });
    expect(hooks.parse(bounce.body, bounce.headers)).toEqual([
      expect.objectContaining({
        type: "bounced",
        bounce: "hard",
        recipient: "ana@example.org",
        providerMessageId: "0100019a-tosend-1",
        provider: "tosend",
        rawType: "bounced",
      }),
    ]);
    const complaint = await signed(toSendComplaint("ana@example.org"));
    expect(await hooks.verify({ ...complaint, secret: SECRET, now: NOW })).toEqual({ ok: true });
    expect(hooks.parse(complaint.body, complaint.headers)).toEqual([
      expect.objectContaining({ type: "complained", recipient: "ana@example.org" }),
    ]);
  });

  it("uses the SHA-256 of the raw body as the event key", async () => {
    const body = utf8(toSendBounce("ana@example.org"));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(hooks.parse(body, new Headers())[0]?.eventKey).toBe(hex);
  });

  it("gives two events with distinct keys for two recipients of one message", async () => {
    const first = await signed(toSendBounce("ana@example.org"));
    const second = await signed(toSendBounce("bo@example.org"));
    const events = [
      ...hooks.parse(first.body, first.headers),
      ...hooks.parse(second.body, second.headers),
    ];
    expect(events.map((event) => event.recipient)).toEqual(["ana@example.org", "bo@example.org"]);
    expect(events[0]?.providerMessageId).toBe(events[1]?.providerMessageId);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(2);

    const both = utf8(`[${toSendBounce("ana@example.org")},${toSendBounce("bo@example.org")}]`);
    const batch = hooks.parse(both, new Headers());
    expect(batch).toHaveLength(2);
    expect(batch[0]?.eventKey).not.toBe(batch[1]?.eventKey);
  });

  it("refuses a wrong signature, a changed body, and a broken header", async () => {
    const sample = await signed(toSendBounce("ana@example.org"));
    expect(await hooks.verify({ ...sample, secret: "other-secret", now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const changed = utf8(toSendBounce("eve@example.org"));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      await hooks.verify({
        headers: new Headers({ "x-tosend-signature": "sha1=abc" }),
        body: sample.body,
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      await hooks.verify({ headers: new Headers(), body: sample.body, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("verifies over the raw bytes and refuses invalid UTF-8 at decode", async () => {
    const body = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]);
    const headers = new Headers({ "x-tosend-signature": await toSendSignature(SECRET, body) });
    expect(await hooks.verify({ headers, body, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(hooks.parse(body, headers)).toEqual([]);
  });
});
