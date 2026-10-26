import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_FIXTURE_ACCOUNT,
  CLOUDFLARE_FIXTURE_MESSAGE_ID,
} from "../../src/conformance/fixtures/cloudflare";
import { type CapturedRequest, mockFetch } from "../../src/conformance/index";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { utf8 } from "../../src/provider-kit/index";
import { classifyBindingError } from "../../src/providers/cloudflare/binding";
import {
  type CloudflareEmailBuilder,
  type CloudflareSendEmail,
  cloudflareBinding,
  cloudflareRest,
} from "../../src/providers/cloudflare/index";
import { cloudflareBindingMeta, cloudflareRestMeta } from "../../src/providers/cloudflare/meta";
import { handleWebhook } from "../../src/webhooks/index";

declare global {
  interface ImportMeta {
    glob(
      pattern: string | string[],
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

const API = "https://api.cloudflare.com/client/v4";
const SEND_URL = `${API}/accounts/${CLOUDFLARE_FIXTURE_ACCOUNT}/email/sending/send`;
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const TOKEN = "cf_test_token_0123456789";

function ctx(fetch: SendContext["fetch"], credentials: Record<string, string> = {}): SendContext {
  return {
    fetch,
    timeoutMs: 1000,
    credentials: { accountId: CLOUDFLARE_FIXTURE_ACCOUNT, apiToken: TOKEN, ...credentials },
    now: NOW,
  };
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

// The success body of the REST guide example. It has no message_id.
const GUIDE_SUCCESS = {
  success: true,
  errors: [],
  messages: [],
  result: { delivered: ["ana@example.org"], permanent_bounces: [], queued: [] },
};

function restMock(response: Parameters<typeof mockFetch>[0][number]["response"]) {
  return mockFetch([{ label: "send", method: "POST", url: SEND_URL, response }]);
}

describe("cloudflareRest send", () => {
  it("posts the documented JSON and returns sent with no provider message id", async () => {
    const mock = restMock({ status: 200, body: GUIDE_SUCCESS });
    const result = await cloudflareRest().send(
      message({
        cc: [{ email: "bo@example.org", name: "Bo" }],
        bcc: ["audit@example.com"],
        replyTo: "Help <help@example.com>",
        headers: { "X-Entity-Ref": "inv-42" },
        attachments: [{ filename: "invoice-42.pdf", content: PDF, contentType: "application/pdf" }],
      }),
      ctx(mock.fetch),
    );
    expect(result).toEqual({ status: "sent", provider: "cloudflare-rest" });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(json(mock.calls[0])).toEqual({
      from: { address: "billing@example.com", name: "Acme Billing" },
      to: ["ana@example.org"],
      cc: [{ address: "bo@example.org", name: "Bo" }],
      bcc: ["audit@example.com"],
      reply_to: "help@example.com",
      subject: "Invoice 42",
      html: "<p>Your invoice is attached.</p>",
      text: "Your invoice is attached.",
      headers: { "X-Entity-Ref": "inv-42" },
      attachments: [
        {
          content: "JVBERi0xLjcKJW1haWxzd2l0Y2ggdGVzdAo=",
          filename: "invoice-42.pdf",
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });
  });

  it("returns message_id when the API reference shape carries it", async () => {
    const body = { ...GUIDE_SUCCESS, result: { ...GUIDE_SUCCESS.result, message_id: "m-1" } };
    const result = await cloudflareRest().send(
      message(),
      ctx(restMock({ status: 200, body }).fetch),
    );
    expect(result).toEqual({
      status: "sent",
      provider: "cloudflare-rest",
      providerMessageId: "m-1",
    });
  });

  it("marks an inline attachment with its content id", async () => {
    const mock = restMock({ status: 200, body: GUIDE_SUCCESS });
    await cloudflareRest().send(
      message({
        attachments: [
          {
            filename: "logo.png",
            content: "iVBORw==",
            contentType: "image/png",
            contentId: "logo",
          },
        ],
      }),
      ctx(mock.fetch),
    );
    expect((json(mock.calls[0]) as { attachments: unknown[] }).attachments).toEqual([
      {
        content: "iVBORw==",
        filename: "logo.png",
        type: "image/png",
        disposition: "inline",
        content_id: "logo",
      },
    ]);
  });

  it("gives not_sent/rejected when every recipient bounced or was suppressed", async () => {
    const body = {
      success: true,
      errors: [],
      messages: [],
      result: { delivered: [], queued: [], permanent_bounces: ["ANA@example.org"] },
    };
    const result = await cloudflareRest().send(
      message(),
      ctx(restMock({ status: 200, body }).fetch),
    );
    expect(result).toMatchObject({ status: "not_sent", reason: "rejected" });
  });

  it("keeps sent when one recipient of two was delivered", async () => {
    const body = {
      success: true,
      result: { delivered: ["bo@example.org"], queued: [], permanent_bounces: ["ana@example.org"] },
    };
    const result = await cloudflareRest().send(
      message({ to: ["ana@example.org", "bo@example.org"] }),
      ctx(restMock({ status: 200, body }).fetch),
    );
    expect(result.status).toBe("sent");
  });

  it("maps documented error codes to reasons and keeps every 5xx unknown", async () => {
    const send = async (status: number, code: number) =>
      cloudflareRest().send(
        message(),
        ctx(restMock({ status, body: { success: false, errors: [{ code }], result: null } }).fetch),
      );
    expect(await send(404, 10000)).toMatchObject({ status: "not_sent", reason: "auth" });
    expect(await send(403, 10207)).toMatchObject({ status: "not_sent", reason: "auth" });
    expect(await send(400, 10200)).toMatchObject({ status: "not_sent", reason: "invalid_message" });
    expect(await send(429, 10004)).toMatchObject({ status: "not_sent", reason: "rate_limited" });
    expect(await send(503, 10100)).toMatchObject({ status: "unknown", reason: "provider_error" });
    expect(await send(500, 10002)).toMatchObject({ status: "unknown" });
  });

  it("refuses 51 recipients and an oversized message with no request", async () => {
    const mock = restMock({ status: 200, body: GUIDE_SUCCESS });
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@example.org`);
    expect(await cloudflareRest().send(message({ to: many }), ctx(mock.fetch))).toMatchObject({
      status: "not_sent",
      reason: "unsupported",
    });
    const big = "a".repeat(5 * 1024 * 1024 + 1);
    expect(await cloudflareRest().send(message({ html: big }), ctx(mock.fetch))).toMatchObject({
      status: "not_sent",
      reason: "unsupported",
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("uses the options when the credentials are empty", async () => {
    const mock = mockFetch([
      {
        label: "send",
        method: "POST",
        url: "https://proxy.example/v4/accounts/acct/email/sending/send",
        response: { status: 200, body: GUIDE_SUCCESS },
      },
    ]);
    const adapter = cloudflareRest({
      accountId: "acct",
      apiToken: "opt-token",
      baseUrl: "https://proxy.example/v4/",
    });
    const result = await adapter.send(message(), {
      fetch: mock.fetch,
      timeoutMs: 1000,
      credentials: {},
      now: NOW,
    });
    expect(result.status).toBe("sent");
    expect(mock.calls[0]?.headers.get("authorization")).toBe("Bearer opt-token");
  });

  it("throws a TypeError for invalid options", () => {
    expect(() => cloudflareRest({ baseUrl: "not a url" })).toThrow(TypeError);
    expect(() => cloudflareRest({ apiToken: 1 as unknown as string })).toThrow(TypeError);
  });
});

describe("cloudflareRest sendBatch", () => {
  it("sends one request per message and returns results in order", async () => {
    const mock = restMock({ status: 200, body: GUIDE_SUCCESS });
    const messages = Array.from({ length: 7 }, (_, i) => message({ to: [`r${i}@example.org`] }));
    const results = await cloudflareRest().sendBatch?.(messages, ctx(mock.fetch));
    expect(results?.map((item) => item.status)).toEqual(Array(7).fill("sent"));
    expect(mock.calls).toHaveLength(7);
  });

  it("stops after an auth failure and gives the rest not_sent with no request", async () => {
    const mock = restMock({ status: 401, body: { success: false, errors: [{ code: 10101 }] } });
    const messages = Array.from({ length: 12 }, () => message());
    const results = (await cloudflareRest().sendBatch?.(messages, ctx(mock.fetch))) ?? [];
    expect(results).toHaveLength(12);
    for (const result of results)
      expect(result).toMatchObject({ status: "not_sent", reason: "auth" });
    expect(mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe("cloudflareRest verify", () => {
  it("accepts a user token after the account path refuses it", async () => {
    const mock = mockFetch([
      {
        label: "account",
        method: "GET",
        url: `${API}/accounts/${CLOUDFLARE_FIXTURE_ACCOUNT}/tokens/verify`,
        response: { status: 401, body: { success: false } },
      },
      {
        label: "user",
        method: "GET",
        url: `${API}/user/tokens/verify`,
        response: { status: 200, body: { success: true, result: { status: "active" } } },
      },
    ]);
    expect(await cloudflareRest().verify(ctx(mock.fetch))).toEqual({ ok: true });
  });

  it("refuses a disabled token", async () => {
    const mock = mockFetch([
      {
        label: "account",
        method: "GET",
        url: `${API}/accounts/${CLOUDFLARE_FIXTURE_ACCOUNT}/tokens/verify`,
        response: { status: 200, body: { success: true, result: { status: "disabled" } } },
      },
    ]);
    expect(await cloudflareRest().verify(ctx(mock.fetch))).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
  });
});

/** A fake binding that records each message and runs `answer`. */
function fakeBinding(answer: () => Promise<unknown>): CloudflareSendEmail & {
  sent: CloudflareEmailBuilder[];
} {
  const sent: CloudflareEmailBuilder[] = [];
  return {
    sent,
    async send(builder) {
      sent.push(builder);
      return (await answer()) as { messageId: string };
    },
  };
}

function coded(code: string): Error {
  return Object.assign(new Error(`binding failed: ${code}`), { code });
}

const noFetch: SendContext["fetch"] = async () => {
  throw new Error("The binding transport must not call fetch.");
};

describe("cloudflareBinding send", () => {
  it("passes the structured message and returns the binding messageId", async () => {
    const binding = fakeBinding(async () => ({ messageId: CLOUDFLARE_FIXTURE_MESSAGE_ID }));
    const result = await cloudflareBinding(binding).send(
      message({
        cc: ["bo@example.org"],
        replyTo: { email: "help@example.com", name: "Help" },
        headers: { "X-Entity-Ref": "inv-42" },
        attachments: [
          { filename: "invoice-42.pdf", content: PDF, contentType: "application/pdf" },
          { filename: "logo.png", content: "AQID", contentType: "image/png", contentId: "logo" },
        ],
      }),
      ctx(noFetch),
    );
    expect(result).toEqual({
      status: "sent",
      provider: "cloudflare-binding",
      providerMessageId: CLOUDFLARE_FIXTURE_MESSAGE_ID,
    });
    const sent = binding.sent[0];
    expect(sent).toMatchObject({
      from: { email: "billing@example.com", name: "Acme Billing" },
      to: ["ana@example.org"],
      cc: ["bo@example.org"],
      replyTo: { email: "help@example.com", name: "Help" },
      subject: "Invoice 42",
      headers: { "X-Entity-Ref": "inv-42" },
    });
    expect(sent?.attachments?.[0]).toMatchObject({ disposition: "attachment", content: PDF });
    expect(sent?.attachments?.[1]).toMatchObject({ disposition: "inline", contentId: "logo" });
    expect(Array.from(sent?.attachments?.[1]?.content as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("gives unknown when the binding throws an error with no code", async () => {
    const binding = fakeBinding(async () => {
      throw new Error("internal error");
    });
    expect(await cloudflareBinding(binding).send(message(), ctx(noFetch))).toMatchObject({
      status: "unknown",
      provider: "cloudflare-binding",
    });
  });

  it("gives unknown for E_DELIVERY_FAILED, E_INTERNAL_SERVER_ERROR, and new codes", () => {
    for (const code of ["E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR", "E_SOMETHING_NEW"]) {
      expect(classifyBindingError(coded(code))).toMatchObject({
        status: "unknown",
        reason: "provider_error",
      });
    }
    expect(classifyBindingError("text")).toMatchObject({ status: "unknown", reason: "network" });
  });

  it("gives not_sent only for documented codes that prove non-acceptance", () => {
    expect(classifyBindingError(coded("E_VALIDATION_ERROR"))).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
    });
    expect(classifyBindingError(coded("E_RECIPIENT_SUPPRESSED"))).toMatchObject({
      status: "not_sent",
      reason: "rejected",
    });
    expect(classifyBindingError(coded("E_DAILY_LIMIT_EXCEEDED"))).toMatchObject({
      status: "not_sent",
      reason: "quota",
    });
    expect(classifyBindingError(coded("E_RATE_LIMIT_EXCEEDED"))).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
    });
  });

  it("does not copy the error text into the result", async () => {
    const binding = fakeBinding(async () => {
      throw coded("E_VALIDATION_ERROR");
    });
    const result = await cloudflareBinding(binding).send(message(), ctx(noFetch));
    expect(JSON.stringify(result)).not.toContain("binding failed");
  });

  it("gives unknown/timeout when the binding does not answer in time", async () => {
    const binding = fakeBinding(() => new Promise(() => {}));
    const result = await cloudflareBinding(binding).send(message(), {
      ...ctx(noFetch),
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ status: "unknown", reason: "timeout" });
  });

  it("finds the binding in env by the bindingName credential", async () => {
    const binding = fakeBinding(async () => undefined);
    const adapter = cloudflareBinding({ env: { MAILER: binding } });
    const result = await adapter.send(message(), ctx(noFetch, { bindingName: "MAILER" }));
    expect(result).toEqual({ status: "sent", provider: "cloudflare-binding" });
    expect(await adapter.verify(ctx(noFetch, { bindingName: "MAILER" }))).toEqual({ ok: true });
    expect(await adapter.verify(ctx(noFetch, { bindingName: "EMAIL" }))).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
    expect(await adapter.send(message(), ctx(noFetch, { bindingName: "EMAIL" }))).toMatchObject({
      status: "not_sent",
      reason: "auth",
    });
  });

  it("throws a TypeError for an invalid source", () => {
    expect(() => cloudflareBinding(null as unknown as CloudflareSendEmail)).toThrow(TypeError);
    expect(() => cloudflareBinding({} as unknown as CloudflareSendEmail)).toThrow(TypeError);
  });
});

describe("Cloudflare webhooks", () => {
  it("declares no webhooks for either transport", () => {
    for (const adapter of [cloudflareRest(), cloudflareBinding(fakeBinding(async () => ({})))]) {
      expect(adapter.meta.webhooks).toBe(false);
      expect(adapter.webhooks).toBeUndefined();
    }
    expect(cloudflareRestMeta.capabilities.batchSize).toBe(25);
    expect(cloudflareBindingMeta.capabilities.batchSize).toBe(1);
  });

  it("refuses a webhook route that uses a Cloudflare adapter", () => {
    const request = new Request("https://app.example/webhooks", { method: "POST", body: "{}" });
    for (const adapter of [cloudflareRest(), cloudflareBinding(fakeBinding(async () => ({})))]) {
      expect(() => handleWebhook(request, { adapter, secret: "s" })).toThrow(
        /has no webhook methods/,
      );
    }
  });
});

// Vite reads the sources as text at transform time, so the test needs no Node APIs.
const sources: Record<string, string> = import.meta.glob(["../../src/**/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("cloudflare:* imports", () => {
  it("are absent from every source file, core and providers alike", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(Object.keys(sources)).toContain("../../src/providers/cloudflare/index.ts");
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/(?:from|import)\s*\(?\s*["']cloudflare:/);
    }
  });
});
