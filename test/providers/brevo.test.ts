import { describe, expect, it, vi } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { BREVO_FIXTURE_API_KEY } from "../../src/conformance/fixtures/brevo";
import {
  BREVO_FIXTURE_TOKEN,
  BREVO_MESSAGE_ID,
  brevoEvent,
  smtpFixture,
} from "../../src/conformance/fixtures/smtp";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { ProviderAdapter, SendContext } from "../../src/core/adapter";
import { createMailer } from "../../src/core/pipeline";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import { uuidFromKey } from "../../src/internal/uuid";
import * as brevoEntry from "../../src/providers/brevo/index";
import { BREVO_API_BASE, brevo, brevoMeta } from "../../src/providers/brevo/index";
import * as smtpBrevoEntry from "../../src/providers/smtp/brevo-webhooks";
import { smtp } from "../../src/providers/smtp/index";
import { MemoryDedupeStore, MemoryIdempotencyStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = `${BREVO_API_BASE}/v3/smtp/email`;
const ACCOUNT_URL = `${BREVO_API_BASE}/v3/account`;
const KEY = BREVO_FIXTURE_API_KEY;
const NOW = Date.parse("2026-10-27T12:00:30.000Z");
const MESSAGE_ID = "<202610271200.1@smtp-relay.mailin.fr>";

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
  headers: Record<string, string> = {},
  method = "POST",
): RecordedExchange {
  return { label: `${method} ${url} ${status}`, method, url, response: { status, headers, body } };
}

function accepted(id = MESSAGE_ID): RecordedExchange {
  return exchange(SEND_URL, 201, { messageId: id });
}

function refused(status: number, code?: string): RecordedExchange {
  return exchange(SEND_URL, status, code ? { code, message: "secret-ish body text" } : {});
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

function bodyOf(mock: ReturnType<typeof mockFetch>, index = 0): Record<string, unknown> {
  return JSON.parse(mock.calls[index]?.body ?? "{}") as Record<string, unknown>;
}

describe("brevo send", () => {
  it("maps a full message to the documented payload and returns sent", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([accepted()]);
    const result = await brevo().send(
      message({
        to: ["ana@example.org", { email: "bo@example.org", name: "Bo, Jr." }],
        cc: [{ email: "cc@example.org", name: "Cy" }],
        bcc: ["bcc@example.org"],
        replyTo: "Support <support@example.com>",
        headers: { "X-Invoice": "INV-1" },
        attachments: [
          { filename: "invoice.pdf", content: pdf, contentType: "application/pdf" },
          { filename: "note.txt", content: bytesToBase64(utf8("note")), contentType: "text/plain" },
        ],
      }),
      ctx,
    );
    expect(result).toEqual({ status: "sent", provider: "brevo", providerMessageId: MESSAGE_ID });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("api-key")).toBe(KEY);
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.get("authorization")).toBeNull();
    expect(bodyOf(mock)).toEqual({
      sender: { email: "billing@example.com", name: "Acme Billing" },
      to: [{ email: "ana@example.org" }, { email: "bo@example.org", name: "Bo, Jr." }],
      cc: [{ email: "cc@example.org", name: "Cy" }],
      bcc: [{ email: "bcc@example.org" }],
      replyTo: { email: "support@example.com", name: "Support" },
      subject: "Your invoice",
      htmlContent: "<p>Invoice attached.</p>",
      textContent: "Invoice attached.",
      headers: { "X-Invoice": "INV-1" },
      attachment: [
        { content: bytesToBase64(pdf), name: "invoice.pdf" },
        { content: bytesToBase64(utf8("note")), name: "note.txt" },
      ],
    });
  });

  it("sends only the parts that the message has", async () => {
    const { mock, ctx } = context([accepted()]);
    await brevo().send(message({ html: undefined }), ctx);
    const body = bodyOf(mock);
    expect(body.textContent).toBe("Invoice attached.");
    for (const name of ["htmlContent", "cc", "bcc", "replyTo", "headers", "attachment"]) {
      expect(body).not.toHaveProperty(name);
    }
  });

  it("puts the same derived UUID in the body on every retry, with identical bytes", async () => {
    const { mock, ctx } = context([accepted(), accepted()]);
    const adapter = brevo();
    const keyed = message({ idempotencyKey: "invoice-42", headers: { "X-Invoice": "INV-42" } });
    await adapter.send(keyed, ctx);
    await adapter.send(keyed, ctx);
    const uuid = await uuidFromKey("invoice-42");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(bodyOf(mock).headers).toEqual({ "X-Invoice": "INV-42", idempotencyKey: uuid });
    expect(mock.calls[0]?.body).toBe(mock.calls[1]?.body);
    expect(mock.calls[0]?.body).not.toContain("invoice-42");
    expect([...(mock.calls[0]?.headers.values() ?? [])]).not.toContain(uuid);
  });

  it("gives a different UUID for a different key", async () => {
    expect(await uuidFromKey("invoice-42")).not.toBe(await uuidFromKey("invoice-43"));
  });

  it("adds X-Sib-Sandbox: drop in sandbox mode", async () => {
    const { mock, ctx } = context([accepted()]);
    await brevo({ sandbox: true }).send(message(), ctx);
    expect(bodyOf(mock).headers).toEqual({ "X-Sib-Sandbox": "drop" });
  });

  it("gives unknown for a 2xx with no message id that it can read", async () => {
    for (const body of ["", "not json", { other: 1 }, { messageId: "" }]) {
      const { ctx } = context([exchange(SEND_URL, 201, body)]);
      expect(await brevo().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        provider: "brevo",
      });
    }
    const { ctx } = context([exchange(SEND_URL, 201, { messageIds: ["<a@b>"] })]);
    expect(await brevo().send(message(), ctx)).toMatchObject({
      status: "sent",
      providerMessageId: "<a@b>",
    });
  });

  it("is unknown for duplicate_parameter and duplicate_request on a keyed send", async () => {
    for (const code of ["duplicate_parameter", "duplicate_request"]) {
      const { ctx } = context([refused(400, code)]);
      const result = await brevo().send(message({ idempotencyKey: "invoice-42" }), ctx);
      expect(result).toMatchObject({
        status: "unknown",
        reason: "idempotency_conflict",
        httpStatus: 400,
        provider: "brevo",
      });
      expect(JSON.stringify(result)).not.toContain("secret-ish");
    }
  });

  it("is not_sent/invalid_message for the same codes on a send without a key", async () => {
    for (const code of ["duplicate_parameter", "duplicate_request"]) {
      const { ctx } = context([refused(400, code)]);
      expect(await brevo().send(message(), ctx)).toMatchObject({
        status: "not_sent",
        reason: "invalid_message",
        httpStatus: 400,
      });
    }
  });

  it("refines a 400 from the body code and keeps the body out of the result", async () => {
    const cases: [string | undefined, string][] = [
      ["not_enough_credits", "credits"],
      ["unauthorized", "auth"],
      ["permission_denied", "auth"],
      ["account_under_validation", "auth"],
      ["invalid_parameter", "invalid_message"],
      [undefined, "invalid_message"],
    ];
    for (const [code, reason] of cases) {
      const { ctx } = context([refused(400, code)]);
      const result = await brevo().send(message(), ctx);
      expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: 400 });
      expect(JSON.stringify(result)).not.toContain("secret-ish");
    }
  });

  it("maps 401, 402, and 403", async () => {
    const cases: [number, string][] = [
      [401, "auth"],
      [402, "credits"],
      [403, "auth"],
    ];
    for (const [status, reason] of cases) {
      const { ctx } = context([refused(status)]);
      expect(await brevo().send(message(), ctx)).toMatchObject({
        status: "not_sent",
        reason,
        httpStatus: status,
      });
    }
  });

  it("reads retryAfterMs of a 429 from x-sib-ratelimit-reset", async () => {
    const { ctx } = context([exchange(SEND_URL, 429, "", { "x-sib-ratelimit-reset": "45" })]);
    const result = await brevo().send(message(), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "rate_limited" });
    expect(result.status === "not_sent" && result.retryAfterMs).toBe(45_000);
  });

  it("prefers Retry-After, and ignores a reset value it cannot read", async () => {
    const first = context([
      exchange(SEND_URL, 429, "", { "retry-after": "7", "x-sib-ratelimit-reset": "45" }),
    ]);
    expect(await brevo().send(message(), first.ctx)).toMatchObject({ retryAfterMs: 7000 });
    const second = context([exchange(SEND_URL, 429, "", { "x-sib-ratelimit-reset": "soon" })]);
    const result = await brevo().send(message(), second.ctx);
    expect(result).toMatchObject({ reason: "rate_limited" });
    expect(result).not.toHaveProperty("retryAfterMs");
  });

  it("keeps a 500, a 502, a timeout, and a network error unknown", async () => {
    for (const status of [500, 502]) {
      const { ctx } = context([refused(status, "duplicate_parameter")]);
      expect(await brevo().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
      });
    }
    const slow = context([
      { label: "timeout", method: "POST", url: SEND_URL, response: "timeout" },
    ]);
    expect(await brevo().send(message(), slow.ctx)).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
    const down = context([
      { label: "network", method: "POST", url: SEND_URL, response: "network" },
    ]);
    expect(await brevo().send(message(), down.ctx)).toMatchObject({
      status: "unknown",
      reason: "network",
    });
  });

  it("refuses an attachment with a contentId before any request", async () => {
    const { mock, ctx } = context([accepted()]);
    const result = await brevo().send(
      message({
        attachments: [
          { filename: "logo.png", content: "cG5n", contentType: "image/png", contentId: "logo" },
        ],
      }),
      ctx,
    );
    expect(result).toMatchObject({ status: "not_sent", reason: "unsupported", provider: "brevo" });
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses more than 99 recipients before any request", async () => {
    const { mock, ctx } = context([accepted()]);
    const to = Array.from({ length: 100 }, (_, i) => `r${i}@example.org`);
    expect(await brevo().send(message({ to }), ctx)).toMatchObject({
      status: "not_sent",
      provider: "brevo",
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("uses baseUrl and the option key when the credential is empty", async () => {
    const mock = mockFetch([
      exchange("https://proxy.example.com/v3/smtp/email", 201, { messageId: MESSAGE_ID }),
    ]);
    const ctx: SendContext = { fetch: mock.fetch, timeoutMs: 5_000, credentials: {}, now: NOW };
    const adapter = brevo({ baseUrl: "https://proxy.example.com/", apiKey: "xkeysib-option" });
    expect(await adapter.send(message(), ctx)).toMatchObject({ status: "sent" });
    expect(mock.calls[0]?.headers.get("api-key")).toBe("xkeysib-option");
  });

  it("throws a TypeError for invalid options", () => {
    expect(() => brevo({ baseUrl: "ftp://x" })).toThrow(TypeError);
    expect(() => brevo({ sandbox: "yes" as unknown as boolean })).toThrow(TypeError);
    expect(() => brevo({ apiKey: 1 as unknown as string })).toThrow(TypeError);
    expect(() => brevo(null as unknown as object)).toThrow(TypeError);
  });
});

describe("brevo verify", () => {
  it("is ok with a 200 account answer", async () => {
    const { mock, ctx } = context([
      exchange(ACCOUNT_URL, 200, { email: "a@example.com" }, {}, "GET"),
    ]);
    expect(await brevo().verify(ctx)).toEqual({ ok: true });
    expect(mock.calls[0]?.method).toBe("GET");
    expect(mock.calls[0]?.headers.get("api-key")).toBe(KEY);
  });

  it("is not_sent/auth for a 401", async () => {
    const { ctx } = context([
      exchange(ACCOUNT_URL, 401, { code: "unauthorized", message: "Key not found" }, {}, "GET"),
    ]);
    expect(await brevo().verify(ctx)).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
      provider: "brevo",
    });
  });

  it("is unknown for a 5xx and a network error", async () => {
    const { ctx } = context([exchange(ACCOUNT_URL, 503, "", {}, "GET")]);
    expect(await brevo().verify(ctx)).toMatchObject({ ok: false, status: "unknown" });
    const down = context([
      { label: "network", method: "GET", url: ACCOUNT_URL, response: "network" },
    ]);
    expect(await brevo().verify(down.ctx)).toMatchObject({ ok: false, reason: "network" });
  });
});

describe("brevo meta", () => {
  it("declares native idempotency with a 30-minute window", () => {
    expect(brevoMeta.tier).toBe(1);
    expect(brevoMeta.nativeIdempotency).toBe(true);
    expect(brevoMeta.capabilities.idempotency).toBe(true);
    expect(brevoMeta.nativeIdempotencyWindowMs).toBe(1_800_000);
    expect(brevoMeta.capabilities.maxMessageBytes).toBe(20_000_000);
    expect(brevoMeta.capabilities.maxRecipients).toBe(99);
    expect(brevoMeta.webhooks).toBe(true);
  });

  it("makes createMailer warn about the short window without an idempotency store", () => {
    const warn = vi.fn();
    createMailer({
      providers: [{ adapter: brevo(), credentials: { apiKey: KEY } }],
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("keeps an idempotency key for a short time");
    const quiet = vi.fn();
    createMailer({
      providers: [{ adapter: brevo(), credentials: { apiKey: KEY } }],
      namespace: "test",
      idempotency: new MemoryIdempotencyStore(),
      logger: { warn: quiet },
    });
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("brevo webhooks", () => {
  const sample = (body: unknown) =>
    new Request("https://app.example.com/webhooks/brevo", {
      method: "POST",
      headers: { authorization: `Bearer ${BREVO_FIXTURE_TOKEN}` },
      body: JSON.stringify(body),
    });

  it("is marked as needing a dedupe store and signs no timestamp", () => {
    expect(brevo().requiresDedupe).toBe(true);
    expect(brevo().webhooks.signedTimestamp).toBe(false);
  });

  it("throws a TypeError in handleWebhook with no dedupe store", () => {
    const adapter = brevo() as ProviderAdapter;
    expect(() =>
      handleWebhook(sample(brevoEvent("delivered", "ana@example.org")), {
        adapter: adapter as ProviderAdapter & { requiresDedupe?: false },
        secret: BREVO_FIXTURE_TOKEN,
      }),
    ).toThrow(TypeError);
  });

  it("parses events with the provider id brevo and drops a replay", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = brevo();
    const body = brevoEvent("hard_bounce", "ana@example.org");
    const deliver = () =>
      handleWebhook(sample(body), { adapter, secret: BREVO_FIXTURE_TOKEN, dedupe, now: () => NOW });
    const first = await deliver();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([
      {
        type: "bounced",
        bounce: "hard",
        provider: "brevo",
        providerMessageId: BREVO_MESSAGE_ID,
      },
    ]);
    await first.ack();
    expect(await deliver()).toMatchObject({ ok: true, events: [] });
  });

  it("shares brevoWebhooks with mailswitch/smtp/brevo, and both pass the webhook fixture", async () => {
    expect(brevoEntry.brevoWebhooks).toBe(smtpBrevoEntry.brevoWebhooks);
    expect(brevoEntry.verifyBrevoWebhook).toBe(smtpBrevoEntry.verifyBrevoWebhook);
    expect(brevoEntry.BREVO_WEBHOOK_EVENTS).toBe(smtpBrevoEntry.BREVO_WEBHOOK_EVENTS);
    const webhookIds = (id: string) => id.startsWith("webhook.") || id === "events.parse";
    const api = await runChecks({
      adapter: brevo(),
      fixture: (await import("../../src/conformance/fixtures/brevo")).brevoFixture(),
      tier: 1,
    });
    const relay = await runChecks({
      adapter: smtp({ preset: "brevo", webhooks: smtpBrevoEntry.brevoWebhooks() }),
      fixture: smtpFixture(),
      tier: 1,
    });
    for (const report of [api, relay]) {
      const hooks = report.checks.filter((entry) => webhookIds(entry.id));
      expect(hooks.length).toBeGreaterThan(0);
      expect(hooks.filter((entry) => entry.status === "fail")).toEqual([]);
    }
    // The SMTP default keeps its own provider id.
    const events = smtpBrevoEntry
      .brevoWebhooks()
      .parse(utf8(JSON.stringify(brevoEvent("spam", "dan@example.org"))), new Headers());
    expect(events[0]?.provider).toBe("smtp");
  });
});
