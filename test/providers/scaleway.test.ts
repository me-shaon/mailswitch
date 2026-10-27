import { describe, expect, it } from "vitest";
import { getProviderMeta } from "../../src/catalog/index";
import {
  SCALEWAY_BAD_KEY,
  SCALEWAY_DOMAINS,
  SCALEWAY_EMAIL_ID,
  SCALEWAY_FIXTURE_PROJECT_ID,
  SCALEWAY_FIXTURE_SECRET_KEY,
  SCALEWAY_INVALID,
  SCALEWAY_SEND_URL,
  SCALEWAY_VERIFY_URL,
  scalewayAnswer,
  scalewayEmail,
  scalewayError,
} from "../../src/conformance/fixtures/scaleway";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  SCALEWAY_API_BASE,
  SCALEWAY_TEM_PATH,
  scaleway,
  scalewayMeta,
} from "../../src/providers/scaleway/index";

const SEND_URL = SCALEWAY_SEND_URL;
const VERIFY_URL = SCALEWAY_VERIFY_URL;
const KEY = SCALEWAY_FIXTURE_SECRET_KEY;
const PROJECT = SCALEWAY_FIXTURE_PROJECT_ID;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");

function context(exchanges: RecordedExchange[], credentials: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = {
    fetch: mock.fetch,
    timeoutMs: 5_000,
    credentials: { secretKey: KEY, projectId: PROJECT, ...credentials },
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
  const result = await scaleway().send(message(overrides), ctx);
  expect(result).toMatchObject({ status: "not_sent", reason, provider: "scaleway" });
  expect(mock.calls).toHaveLength(0);
}

/** Sends one message against one answer and returns the result. */
async function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const { ctx } = context([exchange(SEND_URL, status, body, "POST", headers)]);
  return scaleway().send(message(), ctx);
}

describe("scaleway meta", () => {
  it("declares tier 2, the documented limits, and no webhooks", () => {
    expect(scalewayMeta).toMatchObject({
      id: "scaleway",
      tier: 2,
      webhooks: false,
      nativeIdempotency: false,
      capabilities: {
        attachments: true,
        maxMessageBytes: 2_000_000,
        maxRecipients: 10,
        batchSize: 1,
        idempotency: false,
      },
    });
    expect(getProviderMeta("scaleway")).toBe(scalewayMeta);
    expect(scalewayMeta.credentialFields.map((field) => [field.name, field.secret])).toEqual([
      ["secretKey", true],
      ["projectId", false],
    ]);
  });

  it("uses the only region of the service", () => {
    expect(`${SCALEWAY_API_BASE}${SCALEWAY_TEM_PATH}`).toBe(
      "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par",
    );
  });
});

describe("scaleway send", () => {
  it("maps cc, bcc, reply-to, a custom header, and an attachment to the documented payload", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([exchange(SEND_URL, 200, scalewayAnswer().body)]);
    const result = await scaleway().send(
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
    expect(result).toEqual({
      status: "sent",
      provider: "scaleway",
      providerMessageId: SCALEWAY_EMAIL_ID,
    });
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(
      "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails",
    );
    expect(call?.headers.get("x-auth-token")).toBe(KEY);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.get("authorization")).toBeNull();
    expect(JSON.parse(call?.body ?? "")).toEqual({
      from: { email: "billing@example.com", name: "Acme Billing" },
      to: [{ email: "ana@example.org", name: "Ana" }],
      cc: [{ email: "cc@example.org", name: "Cy" }, { email: "dee@example.org" }],
      bcc: [{ email: "bcc@example.org" }],
      subject: "Your invoice",
      text: "Invoice attached.",
      html: "<p>Invoice attached.</p>",
      project_id: PROJECT,
      attachments: [{ name: "invoice.pdf", type: "application/pdf", content: bytesToBase64(pdf) }],
      additional_headers: [
        { key: "Reply-To", value: "Support <support@example.com>" },
        { key: "X-Invoice", value: "INV-1" },
      ],
    });
  });

  it("sends a minimal message with no optional fields", async () => {
    const { mock, ctx } = context([exchange(SEND_URL, 200, scalewayAnswer().body)]);
    await scaleway().send(
      { from: "a@example.com", to: ["b@example.org"], subject: "Hi", text: "Hi" },
      ctx,
    );
    expect(JSON.parse(mock.calls[0]?.body ?? "")).toEqual({
      from: { email: "a@example.com" },
      to: [{ email: "b@example.org" }],
      subject: "Hi",
      text: "Hi",
      project_id: PROJECT,
    });
  });

  it("encodes a non-ASCII Reply-To name and quotes a name with specials", async () => {
    const { mock, ctx } = context([
      exchange(SEND_URL, 200, scalewayAnswer().body),
      exchange(SEND_URL, 200, scalewayAnswer().body),
    ]);
    const adapter = scaleway();
    await adapter.send(message({ replyTo: { email: "zoe@example.com", name: "Zoé" } }), ctx);
    await adapter.send(message({ replyTo: { email: "s@example.com", name: "Help, Desk" } }), ctx);
    const values = mock.calls.map(
      (call) =>
        (JSON.parse(call.body) as { additional_headers: { value: string }[] }).additional_headers[0]
          ?.value,
    );
    expect(values[0]).toBe(`=?UTF-8?B?${bytesToBase64(utf8("Zoé"))}?= <zoe@example.com>`);
    expect(values[1]).toBe('"Help, Desk" <s@example.com>');
  });

  it("passes a string attachment through as base64", async () => {
    const { mock, ctx } = context([exchange(SEND_URL, 200, scalewayAnswer().body)]);
    await scaleway().send(
      message({ attachments: [{ filename: "a.txt", content: "aGk=", contentType: "text/plain" }] }),
      ctx,
    );
    expect(JSON.parse(mock.calls[0]?.body ?? "").attachments).toEqual([
      { name: "a.txt", type: "text/plain", content: "aGk=" },
    ]);
  });

  it("uses the options when the credentials are empty, and trims them", async () => {
    const { mock, ctx } = context([exchange(SEND_URL, 200, scalewayAnswer().body)], {
      secretKey: "",
      projectId: "",
    });
    await scaleway({ secretKey: ` ${KEY} `, projectId: PROJECT }).send(message(), ctx);
    expect(mock.calls[0]?.headers.get("x-auth-token")).toBe(KEY);
    expect(JSON.parse(mock.calls[0]?.body ?? "").project_id).toBe(PROJECT);
  });

  it("refuses an attachment with a contentId with no request", async () => {
    await refused({
      attachments: [
        { filename: "logo.png", content: "aGk=", contentType: "image/png", contentId: "logo" },
      ],
    });
  });

  it("refuses 11 recipients with no request", async () => {
    await refused({
      to: Array.from({ length: 6 }, (_, index) => `to${index}@example.org`),
      cc: Array.from({ length: 3 }, (_, index) => `cc${index}@example.org`),
      bcc: ["bcc0@example.org", "bcc1@example.org"],
    });
  });

  it("accepts exactly 10 recipients", async () => {
    const { mock, ctx } = context([exchange(SEND_URL, 200, scalewayAnswer().body)]);
    const result = await scaleway().send(
      message({ to: Array.from({ length: 10 }, (_, index) => `to${index}@example.org`) }),
      ctx,
    );
    expect(result.status).toBe("sent");
    expect(mock.calls).toHaveLength(1);
  });

  it("refuses 11 attachments with no request", async () => {
    await refused({
      attachments: Array.from({ length: 11 }, (_, index) => ({
        filename: `f${index}.txt`,
        content: "aGk=",
        contentType: "text/plain",
      })),
    });
  });

  it("refuses a message over 2 MB with no request", async () => {
    await refused({ text: "a".repeat(2_000_001) });
  });

  it("refuses a send with no Project ID as not_sent/auth, with no request", async () => {
    const { mock, ctx } = context([], { projectId: "" });
    const result = await scaleway().send(message(), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "auth", provider: "scaleway" });
    expect(mock.calls).toHaveLength(0);
  });

  it("takes the id of the first entry when the answer has one entry per recipient", async () => {
    const result = await answer(200, {
      emails: [
        scalewayEmail("first-id", "ana@example.org"),
        scalewayEmail("second-id", "cc@example.org", "cc"),
      ],
    });
    expect(result).toEqual({ status: "sent", provider: "scaleway", providerMessageId: "first-id" });
  });

  it("is sent when only some entries failed", async () => {
    const result = await answer(200, {
      emails: [
        scalewayEmail("first-id", "ana@example.org", "to", "failed"),
        scalewayEmail("second-id", "cc@example.org", "cc", "new"),
      ],
    });
    expect(result).toMatchObject({ status: "sent", providerMessageId: "first-id" });
  });

  it.each([
    ["an empty emails array", { emails: [] }],
    ["no emails field", {}],
    ["an entry with no id", { emails: [{ status: "new" }] }],
    ["an entry with a blank id", { emails: [{ id: " ", status: "new" }] }],
    ["emails that is not an array", { emails: { id: "x" } }],
    ["a body that is not JSON", "OK"],
    [
      "every entry failed or canceled",
      {
        emails: [
          scalewayEmail("a", "ana@example.org", "to", "failed"),
          scalewayEmail("b", "cc@example.org", "cc", "canceled"),
        ],
      },
    ],
  ])("gives unknown for a 2xx with %s", async (_label, body) => {
    const result = await answer(200, body);
    expect(result).toMatchObject({
      status: "unknown",
      reason: "provider_error",
      httpStatus: 200,
      provider: "scaleway",
    });
  });

  it.each([
    [400, "invalid_arguments", "invalid_message"],
    [403, "permissions_denied", "auth"],
    [401, "denied_authentication", "auth"],
    [403, "quotas_exceeded", "quota"],
    [400, "quotas_exceeded", "quota"],
    [404, "not_found", "rejected"],
    [409, "transient_state", "rejected"],
    [400, "out_of_stock", "invalid_message"],
  ])("maps %i %s to not_sent/%s", async (status, type, reason) => {
    const result = await answer(status, scalewayError(status, type, "error").body);
    expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: status });
    expect((result as { message: string }).message).toBe(
      `Scaleway answered with HTTP ${status} ${type} (${reason}).`,
    );
  });

  it("maps the recorded 400 and 401 bodies", async () => {
    expect(await answer(400, SCALEWAY_INVALID.body)).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
    });
    expect(await answer(401, SCALEWAY_BAD_KEY.body)).toMatchObject({
      status: "not_sent",
      reason: "auth",
    });
  });

  it("keeps the status reason for a 4xx with no usable type", async () => {
    expect(await answer(403, { message: "forbidden" })).toMatchObject({ reason: "auth" });
    expect(await answer(400, "not json")).toMatchObject({ reason: "invalid_message" });
    expect(await answer(400, { type: "Not A Type!" })).toMatchObject({
      reason: "invalid_message",
      message: expect.not.stringContaining("Not A Type"),
    });
    expect(await answer(402, { type: 42 })).toMatchObject({ reason: "credits" });
  });

  it("never copies the error message of Scaleway into a result", async () => {
    const result = await answer(400, scalewayError(400, "invalid_arguments", "secret detail").body);
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("gives not_sent/rate_limited with retryAfterMs for a 429", async () => {
    const result = await answer(429, { message: "slow down" }, { "retry-after": "3" });
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 3000,
    });
  });

  it.each([500, 502, 503, 504])(
    "gives unknown for a %i, even with a known type",
    async (status) => {
      const result = await answer(status, scalewayError(status, "invalid_arguments", "x").body);
      expect(result).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        httpStatus: status,
      });
    },
  );

  it("gives unknown for a timeout and a network error", async () => {
    const timeout = context([{ label: "t", method: "POST", url: SEND_URL, response: "timeout" }]);
    expect(await scaleway().send(message(), timeout.ctx)).toMatchObject({
      status: "unknown",
      reason: "timeout",
      provider: "scaleway",
    });
    const network = context([{ label: "n", method: "POST", url: SEND_URL, response: "network" }]);
    expect(await scaleway().send(message(), network.ctx)).toMatchObject({
      status: "unknown",
      reason: "network",
      provider: "scaleway",
    });
  });

  it("keeps the secret key out of every failure result", async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const result = await answer(status, { type: "invalid_arguments", message: KEY });
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });
});

describe("scaleway verify", () => {
  it("is ok for a 200 domain list, and sends the key and the Project ID", async () => {
    const { mock, ctx } = context([exchange(VERIFY_URL, 200, SCALEWAY_DOMAINS.body, "GET")]);
    expect(await scaleway().verify(ctx)).toEqual({ ok: true });
    expect(mock.calls[0]?.url).toBe(
      `https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/domains?project_id=${PROJECT}&page_size=1`,
    );
    expect(mock.calls[0]?.method).toBe("GET");
    expect(mock.calls[0]?.headers.get("x-auth-token")).toBe(KEY);
  });

  it("is ok for an empty domain list", async () => {
    const { ctx } = context([exchange(VERIFY_URL, 200, { total_count: 0, domains: [] }, "GET")]);
    expect(await scaleway().verify(ctx)).toEqual({ ok: true });
  });

  it.each([401, 403])("gives not_sent/auth for a %i", async (status) => {
    const { ctx } = context([exchange(VERIFY_URL, status, SCALEWAY_BAD_KEY.body, "GET")]);
    expect(await scaleway().verify(ctx)).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
      provider: "scaleway",
    });
  });

  it("gives not_sent/auth with no request when the Project ID is empty", async () => {
    const { mock, ctx } = context([], { projectId: "" });
    expect(await scaleway().verify(ctx)).toMatchObject({ ok: false, reason: "auth" });
    expect(mock.calls).toHaveLength(0);
  });

  it("encodes the Project ID in the query", async () => {
    const { mock, ctx } = context(
      [
        {
          label: "verify",
          method: "GET",
          url: /\/domains\?/,
          response: { status: 200, body: SCALEWAY_DOMAINS.body },
        },
      ],
      { projectId: "a&b=c" },
    );
    await scaleway().verify(ctx);
    expect(mock.calls[0]?.url).toContain("project_id=a%26b%3Dc&page_size=1");
  });

  it("gives unknown for a 503 and a network error", async () => {
    const server = context([exchange(VERIFY_URL, 503, "down", "GET")]);
    expect(await scaleway().verify(server.ctx)).toMatchObject({ ok: false, status: "unknown" });
    const network = context([{ label: "n", method: "GET", url: VERIFY_URL, response: "network" }]);
    expect(await scaleway().verify(network.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });
});

describe("scaleway options", () => {
  it("throws a TypeError for bad options", () => {
    expect(() => scaleway(null as never)).toThrow(TypeError);
    expect(() => scaleway({ secretKey: 1 as never })).toThrow(
      "scaleway: secretKey must be a string.",
    );
    expect(() => scaleway({ projectId: 1 as never })).toThrow(
      "scaleway: projectId must be a string.",
    );
    expect(() => scaleway({ baseUrl: "http://example.com" })).toThrow(TypeError);
    expect(() => scaleway({ baseUrl: "https://example.com/?key=1" })).toThrow(TypeError);
  });

  it("sends to a custom origin", async () => {
    const url = `https://proxy.example.com${SCALEWAY_TEM_PATH}/emails`;
    const { mock, ctx } = context([exchange(url, 200, scalewayAnswer().body)]);
    await scaleway({ baseUrl: "https://proxy.example.com/" }).send(message(), ctx);
    expect(mock.calls[0]?.url).toBe(url);
  });
});
