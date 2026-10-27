import { describe, expect, it } from "vitest";
import {
  ZEPTOMAIL_BAD_TOKEN,
  ZEPTOMAIL_FIXTURE_TOKEN,
  ZEPTOMAIL_NO_RECIPIENT,
  ZEPTOMAIL_REQUEST_ID,
  zeptomailAnswer,
  zeptomailDataError,
  zeptomailError,
} from "../../src/conformance/fixtures/zeptomail";
import {
  type CapturedRequest,
  mockFetch,
  type RecordedExchange,
  type RecordedHttpResponse,
} from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import { parseCredentials } from "../../src/core/credentials";
import { defineProviderMeta } from "../../src/core/meta";
import { createMailer } from "../../src/core/pipeline";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  ZEPTOMAIL_HOSTS,
  type ZeptomailRegion,
  zeptomail,
  zeptomailMeta,
} from "../../src/providers/zeptomail/index";

const BASE = ZEPTOMAIL_HOSTS.com;
const SEND_URL = `${BASE}/v1.1/email`;
const TOKEN = ZEPTOMAIL_FIXTURE_TOKEN;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");

function context(
  exchanges: RecordedExchange[],
  credentials: Record<string, string> = { token: TOKEN },
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

describe("zeptomail send", () => {
  it("maps a full message with an inline image to the documented payload", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([answer(zeptomailAnswer())]);
    const result = await zeptomail().send(
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
      provider: "zeptomail",
      providerMessageId: ZEPTOMAIL_REQUEST_ID,
    });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(`Zoho-enczapikey ${TOKEN}`);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.body).not.toContain(TOKEN);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      from: { address: "billing@example.com", name: "Acme Billing" },
      to: [
        { email_address: { address: "ana@example.org" } },
        { email_address: { address: "bo@example.org", name: "Bo, Jr." } },
      ],
      cc: [{ email_address: { address: "cc@example.org", name: "Cy" } }],
      bcc: [{ email_address: { address: "bcc@example.org" } }],
      reply_to: [{ address: "support@example.com", name: "Support" }],
      subject: "Your invoice",
      textbody: "Invoice attached.",
      htmlbody: "<p>Invoice attached.</p>",
      mime_headers: { "X-Invoice": "INV-1" },
      attachments: [
        { content: bytesToBase64(pdf), mime_type: "application/pdf", name: "invoice.pdf" },
      ],
      inline_images: [
        {
          content: bytesToBase64(utf8("png")),
          mime_type: "image/png",
          name: "logo.png",
          cid: "logo",
        },
      ],
    });
  });

  it("sends only the parts that the message has", async () => {
    const { mock, ctx } = context([answer(zeptomailAnswer())]);
    await zeptomail().send(message({ html: undefined, idempotencyKey: "invoice-1" }), ctx);
    const body = sentBody(mock);
    expect(body.textbody).toBe("Invoice attached.");
    for (const name of [
      "htmlbody",
      "cc",
      "bcc",
      "reply_to",
      "mime_headers",
      "attachments",
      "inline_images",
    ]) {
      expect(body[name]).toBeUndefined();
    }
    expect(mock.calls[0]?.body).not.toContain("invoice-1");
  });

  it("sends one prefix for a token pasted with the Zoho-enczapikey prefix", async () => {
    for (const token of [`Zoho-enczapikey ${TOKEN}`, `zoho-enczapikey  ${TOKEN}`]) {
      const { mock, ctx } = context([answer(zeptomailAnswer())], { token });
      await zeptomail().send(message(), ctx);
      expect(mock.calls[0]?.headers.get("authorization")).toBe(`Zoho-enczapikey ${TOKEN}`);
    }
  });

  it("takes the token from the options when the context has none", async () => {
    const { mock, ctx } = context([answer(zeptomailAnswer())], {});
    await zeptomail({ token: TOKEN }).send(message(), ctx);
    expect(mock.calls[0]?.headers.get("authorization")).toBe(`Zoho-enczapikey ${TOKEN}`);
  });

  it("sends to the host of the region credential", async () => {
    const regions: [ZeptomailRegion, string][] = [
      ["com", "https://api.zeptomail.com"],
      ["eu", "https://api.zeptomail.eu"],
      ["in", "https://api.zeptomail.in"],
      ["com.au", "https://api.zeptomail.com.au"],
      ["jp", "https://api.zeptomail.jp"],
      ["ca", "https://api.zeptomail.ca"],
      ["sa", "https://api.zeptomail.sa"],
    ];
    for (const [region, host] of regions) {
      const url = `${host}/v1.1/email`;
      const { mock, ctx } = context([answer(zeptomailAnswer(), url)], { token: TOKEN, region });
      expect((await zeptomail().send(message(), ctx)).status).toBe("sent");
      expect(mock.calls[0]?.url).toBe(url);
    }
  });

  it("uses the region option when the credential is empty or defaulted", async () => {
    const url = `${ZEPTOMAIL_HOSTS.eu}/v1.1/email`;
    const plain = context([answer(zeptomailAnswer(), url)]);
    await zeptomail({ region: "eu" }).send(message(), plain.ctx);
    expect(plain.mock.calls[0]?.url).toBe(url);
    const defaulted = context([answer(zeptomailAnswer(), url)], { token: TOKEN, region: "com" });
    defaulted.ctx.defaultedFields = new Set(["region"]);
    await zeptomail({ region: "eu" }).send(message(), defaulted.ctx);
    expect(defaulted.mock.calls[0]?.url).toBe(url);
  });

  it("refuses an unknown region with no request", async () => {
    const { mock, ctx } = context([answer(zeptomailAnswer())], { token: TOKEN, region: "uk" });
    expect(await zeptomail().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "auth",
      provider: "zeptomail",
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("is unknown for a 2xx without EM_104 or with a body it cannot read", async () => {
    for (const response of [
      zeptomailAnswer("EM_999"),
      { status: 200, body: { data: [], message: "OK" } },
      { status: 202, body: { data: { code: "EM_104" } } },
      { status: 200, body: "not json" },
      { status: 200, body: "" },
    ]) {
      const { ctx } = context([answer(response)]);
      expect(await zeptomail().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        provider: "zeptomail",
      });
    }
  });

  it("is sent with no id for EM_104 without a request_id", async () => {
    const { ctx } = context([answer(zeptomailAnswer("EM_104", ""))]);
    expect(await zeptomail().send(message(), ctx)).toEqual({
      status: "sent",
      provider: "zeptomail",
    });
  });

  it("maps a 401 with SERR_157 in the details to not_sent/auth, with no body text", async () => {
    const shapes = [
      ZEPTOMAIL_BAD_TOKEN,
      zeptomailError(401, "TM_9999", "Access Denied", [
        { code: "SERR_157", message: "Invalid API Token found" },
      ]),
    ];
    for (const response of shapes) {
      const { ctx } = context([answer(response)]);
      const result = await zeptomail().send(message(), ctx);
      expect(result).toMatchObject({
        status: "not_sent",
        reason: "auth",
        httpStatus: 401,
        provider: "zeptomail",
      });
      expect(JSON.stringify(result)).not.toContain("Invalid API Token");
    }
  });

  it("maps a 400 data.error_code TM_3201 to not_sent/invalid_message", async () => {
    const { ctx } = context([
      answer(zeptomailDataError(400, "TM_3201", "Mandatory Field Missing")),
    ]);
    const result = await zeptomail().send(message(), ctx);
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
      httpStatus: 400,
    });
    expect(result.status !== "sent" && result.message).toContain("TM_3201");
    expect(JSON.stringify(result)).not.toContain("Mandatory");
  });

  it("refines each 4xx code to its reason in both error shapes", async () => {
    const cases: [string, string][] = [
      ["TM_4001", "auth"],
      ["SERR_156", "auth"],
      ["AE_101", "auth"],
      ["SMI_115", "quota"],
      ["SM_133", "quota"],
      ["LE_101", "credits"],
      ["LE_102", "credits"],
      ["SM_111", "rejected"],
      ["SM_113", "rejected"],
      ["SM_128", "rejected"],
      ["TM_8001", "invalid_message"],
    ];
    for (const [code, reason] of cases) {
      for (const response of [zeptomailError(400, code, "x"), zeptomailDataError(403, code, "x")]) {
        const { ctx } = context([answer(response)]);
        expect(await zeptomail().send(message(), ctx)).toMatchObject({
          status: "not_sent",
          reason,
        });
      }
    }
  });

  it("keeps the default reason for an unknown code, a bad code, or no JSON", async () => {
    for (const response of [
      zeptomailError(400, "XX_1", "x"),
      zeptomailError(400, "<script>", "x"),
      { status: 400, body: "Bad Request" },
    ]) {
      const { ctx } = context([answer(response)]);
      const result = await zeptomail().send(message(), ctx);
      expect(result).toMatchObject({ status: "not_sent", reason: "invalid_message" });
      expect(JSON.stringify(result)).not.toContain("script");
    }
    const { ctx } = context([answer({ status: 404, body: "" })]);
    expect(await zeptomail().send(message(), ctx)).toMatchObject({ reason: "rejected" });
  });

  it("gives a 429 rate_limited with the Retry-After header", async () => {
    const { ctx } = context([answer({ status: 429, headers: { "retry-after": "5" }, body: "" })]);
    expect(await zeptomail().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 5_000,
    });
  });

  it("keeps 500 and 503 unknown, even with a 4xx code in the body", async () => {
    for (const status of [500, 503]) {
      const { ctx } = context([answer(zeptomailError(status, "TM_4001", "x"))]);
      expect(await zeptomail().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
      });
    }
  });

  it("keeps a timeout and a network error unknown", async () => {
    for (const response of ["timeout", "network"] as const) {
      const { ctx } = context([answer(response as unknown as RecordedHttpResponse)]);
      expect(await zeptomail().send(message(), ctx)).toMatchObject({ status: "unknown" });
    }
  });

  it("refuses an invalid message and 501 recipients with no request", async () => {
    const list = Array.from({ length: 501 }, (_, i) => `r${i}@example.org`);
    for (const bad of [message({ to: ["not-an-address"] }), message({ to: list })]) {
      const { mock, ctx } = context([answer(zeptomailAnswer())]);
      expect((await zeptomail().send(bad, ctx)).status).toBe("not_sent");
      expect(mock.calls).toHaveLength(0);
    }
  });

  it("refuses invalid options", () => {
    expect(() => zeptomail({ region: "uk" as ZeptomailRegion })).toThrow(TypeError);
    expect(() => zeptomail({ token: 1 as unknown as string })).toThrow(TypeError);
    expect(() => zeptomail({ fromAddress: 1 as unknown as string })).toThrow(TypeError);
    expect(() => zeptomail(null as unknown as object)).toThrow(TypeError);
  });

  it("goes through the mailer with one request per message", async () => {
    const mock = mockFetch([answer(zeptomailAnswer(), `${ZEPTOMAIL_HOSTS.eu}/v1.1/email`)]);
    const mailer = createMailer({
      providers: [{ adapter: zeptomail(), credentials: { token: TOKEN, region: "eu" } }],
      fetch: mock.fetch,
      now: () => NOW,
      logger: { warn: () => {} },
    });
    const results = await mailer.sendBatch([message(), message({ to: ["bo@example.org"] })]);
    expect(mock.calls).toHaveLength(2);
    expect(results.every((result) => result.status === "sent")).toBe(true);
  });
});

describe("zeptomail credentials and meta", () => {
  it("accepts the documented regions and refuses any other", () => {
    for (const region of ["com", "eu", "in", "com.au", "jp", "ca", "sa"]) {
      expect(parseCredentials(zeptomailMeta, { token: TOKEN, region }).ok).toBe(true);
    }
    for (const region of ["uk", "com.", "comXau", "EU "]) {
      expect(parseCredentials(zeptomailMeta, { token: TOKEN, region }).ok).toBe(false);
    }
    expect(parseCredentials(zeptomailMeta, { token: TOKEN })).toEqual({
      ok: true,
      values: { token: TOKEN, region: "com" },
    });
  });

  it("accepts a pasted prefix and checks fromAddress", () => {
    expect(parseCredentials(zeptomailMeta, { token: `Zoho-enczapikey ${TOKEN}` }).ok).toBe(true);
    expect(parseCredentials(zeptomailMeta, { token: "" }).ok).toBe(false);
    expect(
      parseCredentials(zeptomailMeta, { token: TOKEN, fromAddress: "noreply@example.com" }).ok,
    ).toBe(true);
    expect(parseCredentials(zeptomailMeta, { token: TOKEN, fromAddress: "nobody" }).ok).toBe(false);
  });

  it("is tier 2 with no 5xx override and no webhooks", () => {
    expect(zeptomailMeta.tier).toBe(2);
    expect(zeptomailMeta.webhooks).toBe(false);
    expect(zeptomailMeta.capabilities).toMatchObject({
      maxMessageBytes: 15_000_000,
      maxRecipients: 500,
      batchSize: 1,
    });
    expect(() => defineProviderMeta({ ...zeptomailMeta })).not.toThrow();
    expect(zeptomail().sendBatch).toBeUndefined();
  });
});

describe("zeptomail verify", () => {
  it("is ok for 400 TM_3201, and the probe has no recipient field", async () => {
    const { mock, ctx } = context([answer(ZEPTOMAIL_NO_RECIPIENT)]);
    expect(await zeptomail().verify(ctx)).toEqual({ ok: true });
    const call = mock.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(SEND_URL);
    expect(call?.headers.get("authorization")).toBe(`Zoho-enczapikey ${TOKEN}`);
    const body = sentBody(mock);
    expect(Object.keys(body).sort()).toEqual(["from", "subject"]);
    for (const name of ["to", "cc", "bcc"]) expect(body).not.toHaveProperty(name);
  });

  it("is ok for TM_3201 in the data.error_code shape", async () => {
    const { ctx } = context([
      answer(zeptomailDataError(400, "TM_3201", "Mandatory Field Missing")),
    ]);
    expect(await zeptomail().verify(ctx)).toEqual({ ok: true });
  });

  it("uses fromAddress as the sender, or verify@<region host> when it is empty", async () => {
    const set = context([answer(ZEPTOMAIL_NO_RECIPIENT)], {
      token: TOKEN,
      fromAddress: "noreply@example.com",
    });
    await zeptomail().verify(set.ctx);
    expect(sentBody(set.mock).from).toEqual({ address: "noreply@example.com" });

    const option = context([answer(ZEPTOMAIL_NO_RECIPIENT)]);
    await zeptomail({ fromAddress: "ops@example.com" }).verify(option.ctx);
    expect(sentBody(option.mock).from).toEqual({ address: "ops@example.com" });

    const url = `${ZEPTOMAIL_HOSTS["com.au"]}/v1.1/email`;
    const empty = context([answer(ZEPTOMAIL_NO_RECIPIENT, url)], {
      token: TOKEN,
      region: "com.au",
      fromAddress: "",
    });
    expect(await zeptomail().verify(empty.ctx)).toEqual({ ok: true });
    expect(sentBody(empty.mock).from).toEqual({ address: "verify@api.zeptomail.com.au" });
  });

  it("is not_sent/auth for 401 TM_4001", async () => {
    const { ctx } = context([answer(ZEPTOMAIL_BAD_TOKEN)]);
    const result = await zeptomail().verify(ctx);
    expect(result).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
      httpStatus: 401,
      provider: "zeptomail",
    });
    expect(JSON.stringify(result)).not.toContain("Invalid API Token");
  });

  it("is not ok for a 2xx", async () => {
    for (const response of [zeptomailAnswer(), { status: 200, body: "" }]) {
      const { ctx } = context([answer(response)]);
      expect(await zeptomail().verify(ctx)).toMatchObject({
        ok: false,
        status: "unknown",
        reason: "provider_error",
      });
    }
  });

  it("is not ok for TM_3201 on another status, or for another 4xx", async () => {
    const cases: [RecordedHttpResponse, string][] = [
      [zeptomailError(422, "TM_3201", "x"), "invalid_message"],
      [zeptomailError(400, "TM_8001", "x"), "invalid_message"],
      [zeptomailError(400, "SM_111", "x"), "rejected"],
      [zeptomailDataError(400, "LE_101", "x"), "credits"],
      [{ status: 400, body: "" }, "invalid_message"],
    ];
    for (const [response, reason] of cases) {
      const { ctx } = context([answer(response)]);
      expect(await zeptomail().verify(ctx)).toMatchObject({
        ok: false,
        status: "not_sent",
        reason,
      });
    }
  });

  it("is unknown for a 5xx, a timeout, and a network error", async () => {
    for (const response of [
      zeptomailError(503, "TM_3201", "x"),
      { status: 500, body: "" },
      "timeout",
      "network",
    ] as RecordedHttpResponse[]) {
      const { ctx } = context([answer(response)]);
      expect(await zeptomail().verify(ctx)).toMatchObject({ ok: false, status: "unknown" });
    }
  });

  it("refuses an unknown region with no request", async () => {
    const { mock, ctx } = context([answer(ZEPTOMAIL_NO_RECIPIENT)], {
      token: TOKEN,
      region: "uk",
    });
    expect(await zeptomail().verify(ctx)).toMatchObject({ ok: false, reason: "auth" });
    expect(mock.calls).toHaveLength(0);
  });
});
