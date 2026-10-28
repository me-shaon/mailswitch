import { describe, expect, it } from "vitest";
import {
  RESEND_FIXTURE_SECRET,
  RESEND_FIXTURE_SVIX_ID,
  resendEvent,
  signResendWebhook,
} from "../../src/conformance/fixtures/resend";
import { type CapturedRequest, mockFetch } from "../../src/conformance/index";
import type { SendContext, WebhookVerifyInput } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { base64ToBytes, bytesToBase64, hmacSign, utf8 } from "../../src/provider-kit/index";
import {
  resend,
  resendIdempotencyKey,
  svixSignedPayload,
  svixVerifier,
  verifyResendWebhook,
} from "../../src/providers/resend/index";

const API = "https://api.resend.com";
const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

function ctx(fetch: SendContext["fetch"]): SendContext {
  return { fetch, timeoutMs: 1000, credentials: { apiKey: "re_test_0123456789" }, now: NOW };
}

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: "Acme Billing <billing@example.com>",
    to: ["ana@example.org"],
    subject: "Invoice 42",
    html: "<p>Your invoice is attached.</p>",
    text: "Your invoice is attached.",
    ...overrides,
  };
}

function json(request: CapturedRequest | undefined): unknown {
  return JSON.parse(request?.body ?? "null");
}

const PDF = utf8("%PDF-1.7\n%mailswitch test\n");

describe("resend send", () => {
  it("posts the expected JSON for a PDF send and returns sent with the provider id", async () => {
    const mock = mockFetch([
      {
        label: "send",
        method: "POST",
        url: `${API}/emails`,
        response: { status: 200, body: { id: ID } },
      },
    ]);
    const result = await resend().send(
      message({
        cc: [{ email: "bo@example.org", name: "Bo" }],
        replyTo: "help@example.com",
        headers: { "X-Entity-Ref": "inv-42" },
        attachments: [{ filename: "invoice-42.pdf", content: PDF, contentType: "application/pdf" }],
        idempotencyKey: "invoice-42-send-1",
      }),
      ctx(mock.fetch),
    );
    expect(result).toEqual({ status: "sent", provider: "resend", providerMessageId: ID });
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0] as CapturedRequest;
    expect(call.headers.get("authorization")).toBe("Bearer re_test_0123456789");
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("idempotency-key")).toBe("invoice-42-send-1");
    expect(json(call)).toEqual({
      from: "Acme Billing <billing@example.com>",
      to: ["ana@example.org"],
      cc: ["Bo <bo@example.org>"],
      reply_to: "help@example.com",
      subject: "Invoice 42",
      html: "<p>Your invoice is attached.</p>",
      text: "Your invoice is attached.",
      headers: { "X-Entity-Ref": "inv-42" },
      attachments: [
        {
          filename: "invoice-42.pdf",
          content: bytesToBase64(PDF),
          content_type: "application/pdf",
        },
      ],
    });
  });

  it("sends a 300-character key as its 64-character SHA-256 hex", async () => {
    const key = "k".repeat(300);
    const mock = mockFetch([
      {
        label: "send",
        method: "POST",
        url: `${API}/emails`,
        response: { status: 200, body: { id: ID } },
      },
    ]);
    await resend().send(message({ idempotencyKey: key }), ctx(mock.fetch));
    const sent = mock.calls[0]?.headers.get("idempotency-key") ?? "";
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).toBe(await resendIdempotencyKey(key));
    // Two long keys with a shared 256-character prefix stay distinct.
    expect(await resendIdempotencyKey(`${"k".repeat(256)}a`)).not.toBe(
      await resendIdempotencyKey(`${"k".repeat(256)}b`),
    );
    expect(await resendIdempotencyKey("k".repeat(256))).toBe("k".repeat(256));
  });

  it("gives unknown for a 409 key conflict, so a fallback must not run", async () => {
    const mock = mockFetch([
      {
        label: "conflict",
        method: "POST",
        url: `${API}/emails`,
        response: {
          status: 409,
          body: { name: "concurrent_idempotent_requests", message: "in progress" },
        },
      },
    ]);
    const result = await resend().send(message({ idempotencyKey: "k-1" }), ctx(mock.fetch));
    // unknown means the email may have gone out. The pipeline never retries or falls back.
    expect(result).toMatchObject({
      status: "unknown",
      reason: "idempotency_conflict",
      httpStatus: 409,
      provider: "resend",
    });
  });

  it("refines a 429 daily quota to quota and never copies the body", async () => {
    const mock = mockFetch([
      {
        label: "quota",
        method: "POST",
        url: `${API}/emails`,
        response: { status: 429, body: { name: "daily_quota_exceeded", message: "secret body" } },
      },
    ]);
    const result = await resend().send(message(), ctx(mock.fetch));
    expect(result).toMatchObject({ status: "not_sent", reason: "quota", httpStatus: 429 });
    expect(JSON.stringify(result)).not.toContain("secret body");
  });

  it("refuses an oversized recipient list with no request", async () => {
    const mock = mockFetch([]);
    const to = Array.from({ length: 51 }, (_, i) => `r${i}@example.org`);
    const result = await resend().send(message({ to }), ctx(mock.fetch));
    expect(result).toMatchObject({ status: "not_sent", reason: "unsupported" });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws for invalid options", () => {
    expect(() => resend({ baseUrl: "not a url" })).toThrow(TypeError);
    expect(() => resend({ baseUrl: "ftp://example.com" })).toThrow(TypeError);
  });

  it("uses baseUrl and the option key when the context has none", async () => {
    const mock = mockFetch([
      {
        label: "send",
        method: "POST",
        url: "https://proxy.test/emails",
        response: { status: 200, body: { id: ID } },
      },
    ]);
    const adapter = resend({ apiKey: "re_option", baseUrl: "https://proxy.test/" });
    const result = await adapter.send(message(), { ...ctx(mock.fetch), credentials: {} });
    expect(result.status).toBe("sent");
    expect(mock.calls[0]?.headers.get("authorization")).toBe("Bearer re_option");
  });
});

describe("resend sendBatch", () => {
  it("sends an attachment message alone and the rest in one batch with no key", async () => {
    const mock = mockFetch([
      {
        label: "batch",
        method: "POST",
        url: `${API}/emails/batch`,
        response: { status: 200, body: { data: [{ id: "b-1" }, { id: "b-2" }] } },
      },
      {
        label: "single",
        method: "POST",
        url: `${API}/emails`,
        response: { status: 200, body: { id: "s-1" } },
      },
    ]);
    const results = await resend().sendBatch?.(
      [
        message({ to: ["one@example.org"], idempotencyKey: "batch-1" }),
        message({
          to: ["two@example.org"],
          attachments: [{ filename: "a.pdf", content: PDF, contentType: "application/pdf" }],
          idempotencyKey: "batch-2",
        }),
        message({ to: ["three@example.org"], idempotencyKey: "batch-3" }),
      ],
      ctx(mock.fetch),
    );
    expect(results).toEqual([
      { status: "sent", provider: "resend", providerMessageId: "b-1" },
      { status: "sent", provider: "resend", providerMessageId: "s-1" },
      { status: "sent", provider: "resend", providerMessageId: "b-2" },
    ]);
    const batch = mock.calls.find((call) => call.url.endsWith("/emails/batch"));
    const single = mock.calls.find((call) => call.url.endsWith("/emails"));
    expect(batch?.headers.get("idempotency-key")).toBeNull();
    const items = json(batch) as { to: string[]; attachments?: unknown }[];
    expect(items.map((item) => item.to[0])).toEqual(["one@example.org", "three@example.org"]);
    expect(items.every((item) => item.attachments === undefined)).toBe(true);
    expect((json(single) as { to: string[] }).to).toEqual(["two@example.org"]);
    expect(single?.headers.get("idempotency-key")).toBe("batch-2");
  });

  it("gives each batch message the same failure for a 5xx", async () => {
    const mock = mockFetch([
      { label: "batch", method: "POST", url: `${API}/emails/batch`, response: { status: 503 } },
    ]);
    const results = await resend().sendBatch?.([message(), message()], ctx(mock.fetch));
    expect(results?.map((result) => result.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("resend verify", () => {
  it("accepts a sending-only key", async () => {
    const mock = mockFetch([
      {
        label: "restricted",
        method: "GET",
        url: `${API}/domains`,
        response: { status: 401, body: { name: "restricted_api_key", message: "restricted" } },
      },
    ]);
    expect(await resend().verify(ctx(mock.fetch))).toEqual({ ok: true });
  });

  it("refuses a missing key as not_sent/auth", async () => {
    const mock = mockFetch([
      {
        label: "missing",
        method: "GET",
        url: `${API}/domains`,
        response: { status: 401, body: { name: "missing_api_key", message: "missing" } },
      },
    ]);
    expect(await resend().verify(ctx(mock.fetch))).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
  });
});

describe("resend webhooks", () => {
  const hooks = resend().webhooks;
  if (!hooks) throw new Error("The Resend adapter has no webhooks.");

  async function input(
    body: Uint8Array,
    at = NOW,
    overrides: Partial<WebhookVerifyInput> = {},
  ): Promise<WebhookVerifyInput> {
    const sample = await signResendWebhook({ body, secret: RESEND_FIXTURE_SECRET, at });
    return { headers: sample.headers, body, secret: RESEND_FIXTURE_SECRET, now: NOW, ...overrides };
  }

  const bounce = utf8(
    resendEvent("email.bounced", { bounce: { type: "Permanent", subType: "General" } }),
  );

  it("accepts a valid signature and parses bounced/hard", async () => {
    const request = await input(bounce);
    expect(await hooks.verify(request)).toEqual({ ok: true });
    expect(hooks.parse(bounce, request.headers)).toEqual([
      {
        type: "bounced",
        bounce: "hard",
        provider: "resend",
        eventKey: RESEND_FIXTURE_SVIX_ID,
        rawType: "email.bounced",
        recipient: "ana@example.org",
        providerMessageId: ID,
        occurredAt: Date.parse("2026-10-26T12:00:00.000Z"),
      },
    ]);
  });

  it("refuses a 6-minute-old signature as stale", async () => {
    const request = await input(bounce, NOW - 6 * 60 * 1000);
    expect(await hooks.verify(request)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a tampered body", async () => {
    const request = await input(bounce);
    const tampered = utf8(new TextDecoder().decode(bounce).replace("Permanent", "Transient"));
    expect(await hooks.verify({ ...request, body: tampered })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("accepts a header with three entries where only the last is valid", async () => {
    const request = await input(bounce);
    const valid = request.headers.get("svix-signature") ?? "";
    const wrong = `v1,${bytesToBase64(new Uint8Array(32))}`;
    request.headers.set("svix-signature", `v2,${wrong.slice(3)} ${wrong} ${valid}`);
    expect(await hooks.verify(request)).toEqual({ ok: true });
  });

  it("reads at most 10 signature entries", async () => {
    const request = await input(bounce);
    const valid = request.headers.get("svix-signature") ?? "";
    const wrong = `v1,${bytesToBase64(new Uint8Array(32))}`;
    request.headers.set("svix-signature", [...Array(10).fill(wrong), valid].join(" "));
    expect(await hooks.verify(request)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts the webhook-* header names", async () => {
    const request = await input(bounce);
    const headers = new Headers();
    for (const [name, value] of request.headers)
      headers.set(name.replace("svix-", "webhook-"), value);
    expect(await hooks.verify({ ...request, headers })).toEqual({ ok: true });
    expect(hooks.parse(bounce, headers)[0]?.eventKey).toBe(RESEND_FIXTURE_SVIX_ID);
  });

  it("verifies invalid UTF-8 over the raw bytes and refuses it at decode", async () => {
    const body = new Uint8Array([
      ...utf8('{"type":"email.bounced","x":"'),
      0xff,
      0xfe,
      ...utf8('"}'),
    ]);
    const request = await input(body);
    // The signature matches the raw bytes, so only the decode step refuses the body.
    const key = base64ToBytes(RESEND_FIXTURE_SECRET.slice(6)) as Uint8Array;
    const timestamp = request.headers.get("svix-timestamp") ?? "";
    const expected = bytesToBase64(
      await hmacSign(key, svixSignedPayload(RESEND_FIXTURE_SVIX_ID, timestamp, body)),
    );
    expect(request.headers.get("svix-signature")).toBe(`v1,${expected}`);
    expect(await hooks.verify(request)).toEqual({ ok: false, reason: "malformed" });
    expect(hooks.parse(body, request.headers)).toEqual([]);
  });

  it("throws at setup for a bad whsec_ secret, and verify refuses it", async () => {
    expect(() => svixVerifier("whsec_not*base64!")).toThrow(TypeError);
    expect(() => svixVerifier("whsec_")).toThrow(TypeError);
    expect(() => svixVerifier("whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRY")).toThrow(TypeError);
    const request = await input(bounce);
    expect(await verifyResendWebhook({ ...request, secret: "whsec_%%%%" })).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
    expect(await verifyResendWebhook({ ...request, secret: "whsec_" })).toEqual({
      ok: false,
      reason: "invalid_secret",
    });
  });

  it("refuses an empty secret without a throw", async () => {
    const request = await input(bounce);
    expect(await hooks.verify({ ...request, secret: "" })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("maps soft bounces, complaints, deliveries, and unknown types", () => {
    const headers = new Headers({ "svix-id": "msg_1" });
    const parse = (type: string, data: Record<string, unknown> = {}) =>
      hooks.parse(utf8(resendEvent(type, data)), headers)[0];
    expect(parse("email.bounced", { bounce: { type: "Transient" } })).toMatchObject({
      type: "bounced",
      bounce: "soft",
    });
    expect(parse("email.complained")?.type).toBe("complained");
    expect(parse("email.delivered")?.type).toBe("delivered");
    expect(parse("email.delivery_delayed")).toMatchObject({
      type: "unknown",
      rawType: "email.delivery_delayed",
    });
    expect(parse("email.delivered", { to: ["a@example.org", "b@example.org"] })?.recipient).toBe(
      undefined,
    );
  });
});
