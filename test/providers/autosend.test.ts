import { describe, expect, it } from "vitest";
import {
  AUTOSEND_FIXTURE_DOMAINS_URL,
  AUTOSEND_FIXTURE_EMAIL_ID,
  AUTOSEND_FIXTURE_EVENT_TIME,
  AUTOSEND_FIXTURE_KEY,
  AUTOSEND_FIXTURE_SECRET,
  AUTOSEND_FIXTURE_SEND_URL,
  autosendAccepted,
  autosendError,
  autosendEvent,
  signAutosendWebhook,
} from "../../src/conformance/fixtures/autosend";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import { sha256Hex } from "../../src/internal/sha256";
import {
  AUTOSEND_SIGNATURE_HEADER,
  autosend,
  autosendMeta,
  autosendSignature,
  parseAutosendEvents,
} from "../../src/providers/autosend/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = AUTOSEND_FIXTURE_SEND_URL;
const DOMAINS_URL = AUTOSEND_FIXTURE_DOMAINS_URL;
const KEY = AUTOSEND_FIXTURE_KEY;
const SECRET = AUTOSEND_FIXTURE_SECRET;
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
    html: "<p>Invoice attached.</p>",
    text: "Invoice attached.",
    ...overrides,
  };
}

/** Sends a message that must be refused with no request. */
async function refused(overrides: Partial<OutgoingMessage>, reason = "unsupported") {
  const { mock, ctx } = context([]);
  const result = await autosend().send(message(overrides), ctx);
  expect(result).toMatchObject({ status: "not_sent", reason, provider: "autosend" });
  expect(mock.calls).toHaveLength(0);
}

describe("autosend send", () => {
  it("maps one To, two Cc, an attachment, and a custom header to the documented payload", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([exchange(SEND_URL, 200, autosendAccepted("as-1"))]);
    const result = await autosend().send(
      message({
        to: [{ email: "ana@example.org", name: "Ana" }],
        cc: [{ email: "cc@example.org", name: "Cy" }, "dee@example.org"],
        bcc: ["bcc@example.org"],
        replyTo: "Support <support@example.com>",
        headers: { "X-Invoice": "INV-1" },
        attachments: [{ filename: "invoice.pdf", content: pdf, contentType: "application/pdf" }],
      }),
      ctx,
    );
    expect(result).toEqual({ status: "sent", provider: "autosend", providerMessageId: "as-1" });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.has("x-project-id")).toBe(false);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      from: { email: "billing@example.com", name: "Acme Billing" },
      to: { email: "ana@example.org", name: "Ana" },
      cc: [{ email: "cc@example.org", name: "Cy" }, { email: "dee@example.org" }],
      bcc: [{ email: "bcc@example.org" }],
      replyTo: { email: "support@example.com", name: "Support" },
      subject: "Your invoice",
      html: "<p>Invoice attached.</p>",
      text: "Invoice attached.",
      headers: { "X-Invoice": "INV-1" },
      attachments: [
        { fileName: "invoice.pdf", content: bytesToBase64(pdf), contentType: "application/pdf" },
      ],
    });
  });

  it("uses the apiKey option when the credential is empty", async () => {
    const { mock, ctx } = context([exchange(SEND_URL, 200, autosendAccepted())], { apiKey: "" });
    expect(await autosend({ apiKey: KEY }).send(message(), ctx)).toMatchObject({ status: "sent" });
    expect(mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("sends x-project-id for an account key, and refuses an account key with no project", async () => {
    const accountKey = "ASA_test_not_real";
    const credential = context([exchange(SEND_URL, 200, autosendAccepted())], {
      apiKey: accountKey,
      projectId: "project-1",
    });
    expect(await autosend().send(message(), credential.ctx)).toMatchObject({ status: "sent" });
    expect(credential.mock.calls[0]?.headers.get("x-project-id")).toBe("project-1");
    const option = context([exchange(SEND_URL, 200, autosendAccepted())], { apiKey: accountKey });
    await autosend({ projectId: "project-2" }).send(message(), option.ctx);
    expect(option.mock.calls[0]?.headers.get("x-project-id")).toBe("project-2");
    const missing = context([], { apiKey: accountKey });
    const result = await autosend().send(message(), missing.ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "auth", provider: "autosend" });
    expect(JSON.stringify(result)).not.toContain(accountKey);
    expect(missing.mock.calls).toHaveLength(0);
  });

  it("refuses two To recipients with no request", async () => {
    await refused({ to: ["ana@example.org", "bo@example.org"] });
  });

  it("refuses more than 50 recipients with no request", async () => {
    const cc = Array.from({ length: 50 }, (_, i) => `r${i}@example.org`);
    await refused({ cc });
  });

  it("refuses a reserved header, a bad header name, and too many headers with no request", async () => {
    // The core refuses Reply-To for every provider. AutoSend refuses the rest.
    await refused({ headers: { "Reply-To": "x@example.org" } }, "invalid_message");
    await refused({ headers: { "X-SES-Configuration-Set": "set-1" } });
    await refused({ headers: { "Message-ID": "<a@example.com>" } });
    await refused({ headers: { X_Tag: "a" } });
    await refused({ headers: { [`X-${"a".repeat(75)}`]: "a" } });
    await refused({ headers: { "X-Long": "a".repeat(1001) } });
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]));
    await refused({ headers: many });
  });

  it("refuses a header name with a space with no request", async () => {
    const { mock, ctx } = context([]);
    const result = await autosend().send(message({ headers: { "X Tag": "a" } }), ctx);
    expect(result).toMatchObject({ status: "not_sent", provider: "autosend" });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes List-Unsubscribe through, so the send call decides", async () => {
    const { mock, ctx } = context([exchange(SEND_URL, 200, autosendAccepted())]);
    const headers = { "List-Unsubscribe": "<https://example.com/u/1>" };
    expect(await autosend().send(message({ headers }), ctx)).toMatchObject({ status: "sent" });
    expect(JSON.parse(mock.calls[0]?.body ?? "{}").headers).toEqual(headers);
  });

  it("refuses an inline attachment, more than 20 attachments, and a long subject", async () => {
    const file = { filename: "a.txt", content: utf8("a"), contentType: "text/plain" };
    await refused({ attachments: [{ ...file, contentId: "logo" }] });
    await refused({ attachments: Array.from({ length: 21 }, () => file) });
    await refused({ subject: "a".repeat(999) });
    const { ctx } = context([exchange(SEND_URL, 200, autosendAccepted())]);
    expect(
      await autosend().send(message({ attachments: Array.from({ length: 20 }, () => file) }), ctx),
    ).toMatchObject({ status: "sent" });
  });
});

describe("autosend accepted answers", () => {
  it("keeps every 2xx that is not success with an emailId unknown", async () => {
    const bodies: unknown[] = [
      { success: true, data: {} },
      { success: true },
      { success: false, data: { emailId: "as-1" } },
      { data: { emailId: "as-1" } },
      { success: true, data: { emailId: 42 } },
      { success: true, data: { emailId: " " } },
      [],
      "not json",
      "",
    ];
    for (const body of bodies) {
      const { ctx } = context([exchange(SEND_URL, 200, body)]);
      expect(await autosend().send(message(), ctx), JSON.stringify(body)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        provider: "autosend",
      });
    }
    const { ctx } = context([exchange(SEND_URL, 202, autosendAccepted())]);
    expect(await autosend().send(message(), ctx)).toMatchObject({
      status: "sent",
      providerMessageId: AUTOSEND_FIXTURE_EMAIL_ID,
    });
  });
});

describe("autosend failures", () => {
  it("maps the documented codes", async () => {
    const cases: [number, unknown, string][] = [
      [400, autosendError("VALIDATION_FAILED", "bad"), "invalid_message"],
      [401, autosendError("UNAUTHORIZED", "bad"), "auth"],
      [402, autosendError("PLAN_UPGRADE_REQUIRED", "upgrade"), "credits"],
      [403, autosendError("INSUFFICIENT_PERMISSIONS", "no"), "auth"],
      [404, autosendError("NOT_FOUND", "no"), "rejected"],
      [400, { success: false, message: "upgrade", code: "PLAN_UPGRADE_REQUIRED" }, "credits"],
    ];
    for (const [status, body, reason] of cases) {
      const { ctx } = context([exchange(SEND_URL, status, body)]);
      expect(await autosend().send(message(), ctx), JSON.stringify(body)).toMatchObject({
        status: "not_sent",
        reason,
        httpStatus: status,
        provider: "autosend",
      });
    }
  });

  it("reads the flat error shape without a throw", async () => {
    const { ctx } = context([
      exchange(SEND_URL, 404, { success: false, message: "nope", code: "TEMPLATE_NOT_FOUND" }),
    ]);
    const result = await autosend().send(message(), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "rejected", httpStatus: 404 });
    expect(result.status === "not_sent" && result.message).toContain("TEMPLATE_NOT_FOUND");
    for (const body of ["not json", "", [], { error: "text" }, { code: 7 }]) {
      const other = context([exchange(SEND_URL, 400, body)]);
      expect(await autosend().send(message(), other.ctx)).toMatchObject({
        status: "not_sent",
        reason: "invalid_message",
      });
    }
  });

  it("reads retryAfter as seconds when there is no Retry-After, clamped to one hour", async () => {
    const body = autosendError("RATE_LIMIT_EXCEEDED", "slow", { retryAfter: 10 });
    const fromBody = context([exchange(SEND_URL, 429, body)]);
    expect(await autosend().send(message(), fromBody.ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 10_000,
    });
    const header = context([exchange(SEND_URL, 429, body, "POST", { "retry-after": "3" })]);
    expect(await autosend().send(message(), header.ctx)).toMatchObject({ retryAfterMs: 3000 });
    const long = context([
      exchange(SEND_URL, 429, autosendError("RATE_LIMIT_EXCEEDED", "x", { retryAfter: 7200 })),
    ]);
    expect(await autosend().send(message(), long.ctx)).toMatchObject({
      retryAfterMs: 3_600_000,
    });
    const flat = context([
      exchange(SEND_URL, 429, { success: false, code: "RATE_LIMIT_EXCEEDED", retryAfter: 1 }),
    ]);
    expect(await autosend().send(message(), flat.ctx)).toMatchObject({ retryAfterMs: 1000 });
    for (const retryAfter of [-1, "10", null]) {
      const bad = context([
        exchange(SEND_URL, 429, autosendError("RATE_LIMIT_EXCEEDED", "x", { retryAfter })),
      ]);
      const result = await autosend().send(message(), bad.ctx);
      expect(result).toMatchObject({ status: "not_sent", reason: "rate_limited" });
      expect(result.status === "not_sent" && result.retryAfterMs).toBeUndefined();
    }
  });

  it("keeps a 500, a 503, a timeout, and a network error unknown, whatever the body code", async () => {
    for (const status of [500, 502, 503]) {
      const { ctx } = context([
        exchange(SEND_URL, status, autosendError("VALIDATION_FAILED", "down")),
      ]);
      expect(await autosend().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
      });
    }
    for (const response of ["timeout", "network"] as const) {
      const { ctx } = context([{ label: response, method: "POST", url: SEND_URL, response }]);
      expect(await autosend().send(message(), { ...ctx, timeoutMs: 50 })).toMatchObject({
        status: "unknown",
      });
    }
  });

  it("keeps the key and the response body out of a failure", async () => {
    const { ctx } = context([
      exchange(SEND_URL, 401, autosendError("UNAUTHORIZED", `bad key ${KEY}`)),
    ]);
    const result = await autosend().send(message(), ctx);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("bad key");
  });
});

describe("autosend verify", () => {
  it("calls GET /v1/domains and maps the answers", async () => {
    const good = context([
      exchange(DOMAINS_URL, 200, { success: true, data: { domains: [] } }, "GET"),
    ]);
    expect(await autosend().verify(good.ctx)).toEqual({ ok: true });
    expect(good.mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    for (const [status, code] of [
      [401, "UNAUTHORIZED"],
      [403, "INSUFFICIENT_PERMISSIONS"],
    ] as const) {
      const bad = context([exchange(DOMAINS_URL, status, autosendError(code, "no"), "GET")]);
      expect(await autosend().verify(bad.ctx)).toMatchObject({
        ok: false,
        status: "not_sent",
        reason: "auth",
      });
    }
    const down = context([exchange(DOMAINS_URL, 503, "", "GET")]);
    expect(await autosend().verify(down.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });

  it("refuses an account key with no project id with no request", async () => {
    const { mock, ctx } = context([], { apiKey: "ASA_test_not_real" });
    expect(await autosend().verify(ctx)).toMatchObject({ ok: false, reason: "auth" });
    expect(mock.calls).toHaveLength(0);
  });

  it("takes a baseUrl", async () => {
    const url = "http://localhost:8787/v1/domains";
    const { mock, ctx } = context([exchange(url, 200, { success: true }, "GET")]);
    await autosend({ baseUrl: "http://localhost:8787/" }).verify(ctx);
    expect(mock.calls[0]?.url).toBe(url);
  });
});

describe("autosend options", () => {
  it("throws a TypeError for invalid options", () => {
    expect(() => autosend({ baseUrl: "http://api.autosend.com" })).toThrow(TypeError);
    expect(() => autosend({ apiKey: 1 as unknown as string })).toThrow(TypeError);
    expect(() => autosend({ projectId: 1 as unknown as string })).toThrow(TypeError);
    expect(() => autosend(null as unknown as object)).toThrow(TypeError);
  });

  it("marks requiresDedupe and no signed timestamp", () => {
    const adapter = autosend();
    expect(adapter.requiresDedupe).toBe(true);
    expect(adapter.webhooks.signedTimestamp).toBe(false);
  });
});

describe("autosend meta", () => {
  it("declares tier 1 with the documented limits", () => {
    expect(autosendMeta.tier).toBe(1);
    expect(autosendMeta.webhooks).toBe(true);
    expect(autosendMeta.nativeIdempotency).toBe(false);
    expect(autosendMeta.capabilities.maxMessageBytes).toBe(40_000_000);
    expect(autosendMeta.capabilities.maxRecipients).toBe(50);
    expect(autosendMeta.capabilities.batchSize).toBe(1);
  });

  it("checks the key pattern", () => {
    const pattern = new RegExp(autosendMeta.credentialFields[0]?.pattern ?? "");
    for (const good of [KEY, "ASA_test_not_real", "as_test_not_real"]) {
      expect(pattern.test(good), good).toBe(true);
    }
    for (const bad of ["AS_", "AS_has space", "test_not_real", "ASB_test_not_real"]) {
      expect(pattern.test(bad), bad).toBe(false);
    }
  });
});

describe("autosend webhooks", () => {
  const hooks = autosend().webhooks;
  const body = utf8(autosendEvent("email.bounced", { bounceType: "Transient" }));
  const keyOf = (type: string, to: string, createdAt = AUTOSEND_FIXTURE_EVENT_TIME) =>
    sha256Hex(utf8(JSON.stringify([type, AUTOSEND_FIXTURE_EMAIL_ID, to, createdAt])));

  it("passes a body signed with the hex HMAC of the trimmed secret", async () => {
    const sample = await signAutosendWebhook({ body, secret: SECRET });
    expect(sample.headers.get(AUTOSEND_SIGNATURE_HEADER)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hooks.verify({ ...sample, secret: SECRET, now: NOW })).toEqual({ ok: true });
    expect(await hooks.verify({ ...sample, secret: ` ${SECRET}\n`, now: NOW })).toEqual({
      ok: true,
    });
    const upper = new Headers(sample.headers);
    upper.set(
      AUTOSEND_SIGNATURE_HEADER,
      ` ${upper.get(AUTOSEND_SIGNATURE_HEADER)?.toUpperCase()} `,
    );
    expect(await hooks.verify({ headers: upper, body, secret: SECRET, now: NOW })).toEqual({
      ok: true,
    });
  });

  it("gives typed rejections for a changed body, a wrong secret, and bad headers", async () => {
    const sample = await signAutosendWebhook({ body, secret: SECRET });
    const changed = utf8(autosendEvent("email.bounced", { bounceType: "Permanent" }));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    for (const secret of ["other-secret", "", "   "]) {
      expect(await hooks.verify({ ...sample, secret, now: NOW }), secret).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
    expect(await hooks.verify({ headers: new Headers(), body, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const broken = new Headers({ [AUTOSEND_SIGNATURE_HEADER]: "sha256=abc" });
    expect(await hooks.verify({ headers: broken, body, secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a signed body that is not one JSON object", async () => {
    for (const text of ["[]", '"text"', "not json", "null"]) {
      const signed = await signAutosendWebhook({ body: utf8(text), secret: SECRET });
      expect(await hooks.verify({ ...signed, secret: SECRET, now: NOW }), text).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("parses a transient bounce to bounced soft, with a key built from the signed body", () => {
    expect(parseAutosendEvents("autosend", body)).toEqual([
      {
        type: "bounced",
        bounce: "soft",
        provider: "autosend",
        eventKey: keyOf("email.bounced", "ana@example.org"),
        rawType: "email.bounced",
        recipient: "ana@example.org",
        providerMessageId: AUTOSEND_FIXTURE_EMAIL_ID,
        occurredAt: Date.parse(AUTOSEND_FIXTURE_EVENT_TIME),
      },
    ]);
  });

  it("maps every documented event type", () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ["email.delivered", {}, { type: "delivered" }],
      ["email.bounced", { bounceType: "Permanent" }, { type: "bounced", bounce: "hard" }],
      ["email.bounced", { bounceType: "Transient" }, { type: "bounced", bounce: "soft" }],
      ["email.bounced", { bounceType: "Undetermined" }, { type: "bounced" }],
      ["email.bounced", {}, { type: "bounced" }],
      ["email.spam_reported", { complaintType: "abuse" }, { type: "complained" }],
      ["email.sent", {}, { type: "unknown" }],
      ["email.deferred", {}, { type: "unknown" }],
      ["email.opened", {}, { type: "unknown" }],
      ["email.clicked", {}, { type: "unknown" }],
      ["email.unsubscribed", {}, { type: "unsubscribed" }],
      ["email.group_unsubscribed", {}, { type: "unknown" }],
      ["email.group_resubscribed", {}, { type: "unknown" }],
      ["contact.created", {}, { type: "unknown" }],
    ];
    for (const [rawType, data, expected] of cases) {
      const [event] = parseAutosendEvents("autosend", utf8(autosendEvent(rawType, data)));
      expect(event, `${rawType} ${JSON.stringify(data)}`).toMatchObject({ ...expected, rawType });
      if (expected.bounce === undefined) expect(event?.bounce).toBeUndefined();
    }
  });

  it("reads the event name from event when type is missing", () => {
    const raw = JSON.parse(autosendEvent("email.delivered")) as Record<string, unknown>;
    raw.event = raw.type;
    delete raw.type;
    const [event] = parseAutosendEvents("autosend", utf8(JSON.stringify(raw)));
    expect(event).toMatchObject({ type: "delivered", rawType: "email.delivered" });
  });

  it("parses a signed body with no type to unknown, whatever X-Webhook-Event says", async () => {
    const raw = JSON.parse(autosendEvent("email.bounced", { bounceType: "Permanent" })) as Record<
      string,
      unknown
    >;
    delete raw.type;
    const signed = await signAutosendWebhook({ body: utf8(JSON.stringify(raw)), secret: SECRET });
    signed.headers.set("x-webhook-event", "email.bounced");
    expect(await hooks.verify({ ...signed, secret: SECRET, now: NOW })).toEqual({ ok: true });
    const [event] = hooks.parse(signed.body, signed.headers);
    expect(event).toMatchObject({ type: "unknown", rawType: "unknown" });
    expect(event?.bounce).toBeUndefined();
  });

  it("ignores a forged X-Webhook-Event header on a typed body", async () => {
    const signed = await signAutosendWebhook({
      body: utf8(autosendEvent("email.delivered")),
      secret: SECRET,
    });
    signed.headers.set("x-webhook-event", "email.spam_reported");
    const [event] = hooks.parse(signed.body, signed.headers);
    expect(event).toMatchObject({ type: "delivered", rawType: "email.delivered" });
  });

  it("gives the same key for a new delivery id, and for a recipient in another case", () => {
    const first = hooks.parse(body, new Headers({ "x-webhook-delivery-id": "d-1" }));
    const second = hooks.parse(body, new Headers({ "x-webhook-delivery-id": "d-2" }));
    expect(second[0]?.eventKey).toBe(first[0]?.eventKey);
    const upper = utf8(
      autosendEvent("email.bounced", {
        bounceType: "Transient",
        to: { email: "Ana@Example.org", name: "Ana" },
      }),
    );
    const [event] = parseAutosendEvents("autosend", upper);
    expect(event?.eventKey).toBe(first[0]?.eventKey);
    expect(event?.recipient).toBe("Ana@Example.org");
  });

  it("gives a new key for a second real event", () => {
    const [first] = parseAutosendEvents("autosend", body);
    const later = utf8(
      autosendEvent(
        "email.bounced",
        { bounceType: "Transient" },
        {
          createdAt: "2026-10-27T12:30:00.000Z",
        },
      ),
    );
    const [second] = parseAutosendEvents("autosend", later);
    expect(second?.eventKey).not.toBe(first?.eventKey);
    const [delivered] = parseAutosendEvents("autosend", utf8(autosendEvent("email.delivered")));
    expect(delivered?.eventKey).not.toBe(first?.eventKey);
  });

  it("keys a body with no emailId or no createdAt by the body hash", () => {
    const noId = utf8(JSON.stringify({ type: "email.delivered", createdAt: "x", data: {} }));
    expect(parseAutosendEvents("autosend", noId)[0]).toMatchObject({
      eventKey: sha256Hex(noId),
      type: "delivered",
    });
    const noTime = utf8(JSON.stringify({ type: "email.opened", data: { emailId: "as-1" } }));
    const [event] = parseAutosendEvents("autosend", noTime);
    expect(event).toMatchObject({ eventKey: sha256Hex(noTime), providerMessageId: "as-1" });
    expect(event?.occurredAt).toBeUndefined();
    expect(parseAutosendEvents("autosend", utf8("not json"))).toEqual([]);
    expect(parseAutosendEvents("autosend", utf8("[]"))).toEqual([]);
  });

  it("gives the signature that the fixture signer gives", async () => {
    const sample = await signAutosendWebhook({ body, secret: SECRET });
    expect(sample.headers.get(AUTOSEND_SIGNATURE_HEADER)).toBe(
      await autosendSignature(SECRET, body),
    );
  });

  it("drops the same signed body sent again with a new X-Webhook-Delivery-Id", async () => {
    const dedupe = new MemoryDedupeStore();
    const sample = await signAutosendWebhook({ body, secret: SECRET });
    const send = (deliveryId: string) => {
      const headers = new Headers(sample.headers);
      headers.set("x-webhook-delivery-id", deliveryId);
      headers.set("x-webhook-timestamp", String(NOW + 60_000));
      return handleWebhook(
        new Request("https://app.example.com/hooks/autosend", {
          method: "POST",
          headers,
          body: sample.body,
        }),
        { adapter: autosend(), secret: SECRET, dedupe },
      );
    };
    const first = await send("delivery-1");
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "soft" }]);
    await first.ack();
    expect(await send("delivery-2")).toMatchObject({ ok: true, events: [] });
  });
});

describe("autosend unsubscribe", () => {
  it("maps email.unsubscribed to unsubscribed with the message id and no recipient", () => {
    const body = autosendEvent("email.unsubscribed", { to: undefined });
    const events = parseAutosendEvents("autosend", utf8(body));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unsubscribed",
      rawType: "email.unsubscribed",
      providerMessageId: AUTOSEND_FIXTURE_EMAIL_ID,
    });
    expect(events[0]?.recipient).toBeUndefined();
  });

  it("sets no message id when the body has no emailId", () => {
    const body = autosendEvent("email.unsubscribed", { to: undefined, emailId: undefined });
    const events = parseAutosendEvents("autosend", utf8(body));
    expect(events[0]?.type).toBe("unsubscribed");
    expect(events[0]?.providerMessageId).toBeUndefined();
  });

  it.each(["email.group_unsubscribed", "email.group_resubscribed"])(
    "keeps %s as unknown",
    (rawType) => {
      const [event] = parseAutosendEvents("autosend", utf8(autosendEvent(rawType)));
      expect(event).toMatchObject({ type: "unknown", rawType });
    },
  );
});
