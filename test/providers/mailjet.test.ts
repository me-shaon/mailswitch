import { describe, expect, it } from "vitest";
import {
  MAILJET_FIXTURE_SECRET,
  MAILJET_UNAUTHORIZED,
  mailjetAnswer,
  mailjetErrorEntry,
  mailjetEvent,
  mailjetSuccessEntry,
  signMailjetWebhook,
} from "../../src/conformance/fixtures/mailjet";
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
  generateMailjetWebhookSecret,
  MAILJET_API_BASE,
  mailjet,
  mailjetWebhookAuthorization,
  mailjetWebhookUrl,
  parseMailjetEvents,
} from "../../src/providers/mailjet/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = `${MAILJET_API_BASE}/v3.1/send`;
const USER_URL = `${MAILJET_API_BASE}/v3/REST/user`;
const KEY = "testmailjetapikeynotreal0000";
const SECRET_KEY = "testmailjetsecretnotreal0000";
const BASIC = `Basic ${bytesToBase64(utf8(`${KEY}:${SECRET_KEY}`))}`;
const HOOK_SECRET = MAILJET_FIXTURE_SECRET;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");

function context(
  exchanges: RecordedExchange[],
  credentials: Record<string, string> = { apiKey: KEY, secretKey: SECRET_KEY },
) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = { fetch: mock.fetch, timeoutMs: 5_000, credentials, now: NOW };
  return { mock, ctx };
}

function answer(
  response: RecordedHttpResponse | ((request: CapturedRequest) => RecordedHttpResponse),
  url = SEND_URL,
  method = "POST",
): RecordedExchange {
  return { label: `${method} ${url}`, method, url, response };
}

/** Answers each request with one success entry per message, in order. */
function echoSuccess(request: CapturedRequest): RecordedHttpResponse {
  const sent = (JSON.parse(request.body) as { Messages: { To: { Email: string }[] }[] }).Messages;
  return {
    status: 200,
    body: mailjetAnswer(
      ...sent.map((item, index) => mailjetSuccessEntry(item.To[0]?.Email ?? "", `uuid-${index}`)),
    ),
  };
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
  JSON.parse(mock.calls[index]?.body ?? "{}") as {
    Messages: Record<string, unknown>[];
    SandboxMode?: boolean;
  };

describe("mailjet send", () => {
  it("maps a full message with an inline attachment to the documented payload", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context([
      answer({ status: 201, body: mailjetAnswer(mailjetSuccessEntry("ana@example.org")) }),
    ]);
    const result = await mailjet().send(
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
      provider: "mailjet",
      providerMessageId: "1ab23cd4-e567-4901-a345-6789f0ab1c2d",
    });
    const call = mock.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(BASIC);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      Messages: [
        {
          From: { Email: "billing@example.com", Name: "Acme Billing" },
          To: [{ Email: "ana@example.org" }, { Email: "bo@example.org", Name: "Bo, Jr." }],
          Cc: [{ Email: "cc@example.org", Name: "Cy" }],
          Bcc: [{ Email: "bcc@example.org" }],
          ReplyTo: { Email: "support@example.com", Name: "Support" },
          Subject: "Your invoice",
          TextPart: "Invoice attached.",
          HTMLPart: "<p>Invoice attached.</p>",
          Headers: { "X-Invoice": "INV-1" },
          Attachments: [
            {
              ContentType: "application/pdf",
              Filename: "invoice.pdf",
              Base64Content: bytesToBase64(pdf),
            },
          ],
          InlinedAttachments: [
            {
              ContentType: "image/png",
              Filename: "logo.png",
              Base64Content: bytesToBase64(utf8("png")),
              ContentID: "logo",
            },
          ],
        },
      ],
    });
  });

  it("sends only the parts that the message has, no key, and no SandboxMode", async () => {
    const { mock, ctx } = context([answer(echoSuccess)]);
    await mailjet().send(message({ html: undefined, idempotencyKey: "invoice-1" }), ctx);
    const body = sentBody(mock);
    expect(body.SandboxMode).toBeUndefined();
    const entry = body.Messages[0] ?? {};
    expect(entry.TextPart).toBe("Invoice attached.");
    for (const name of ["HTMLPart", "Cc", "Bcc", "ReplyTo", "Headers", "Attachments", "CustomID"]) {
      expect(entry[name]).toBeUndefined();
    }
    expect(mock.calls[0]?.body).not.toContain("invoice-1");
  });

  it("takes the keys from the options when the context has none", async () => {
    const { mock, ctx } = context([answer(echoSuccess)], {});
    await mailjet({ apiKey: KEY, secretKey: SECRET_KEY }).send(message(), ctx);
    expect(mock.calls[0]?.headers.get("authorization")).toBe(BASIC);
  });

  it("sets SandboxMode with the sandbox option, and a sandbox answer is sent with no id", async () => {
    const { mock, ctx } = context([
      answer({
        status: 200,
        body: mailjetAnswer(mailjetSuccessEntry("ana@example.org", "", "0")),
      }),
    ]);
    const result = await mailjet({ sandbox: true }).send(message(), ctx);
    expect(sentBody(mock).SandboxMode).toBe(true);
    expect(result).toEqual({ status: "sent", provider: "mailjet" });
  });

  it("sends to the host of the baseUrl option", async () => {
    const { mock, ctx } = context([answer(echoSuccess, "https://api.us.mailjet.com/v3.1/send")]);
    const result = await mailjet({ baseUrl: "https://api.us.mailjet.com/" }).send(message(), ctx);
    expect(result.status).toBe("sent");
    expect(mock.calls[0]?.url).toBe("https://api.us.mailjet.com/v3.1/send");
  });

  it("refuses invalid options", () => {
    expect(() => mailjet({ baseUrl: "http://api.mailjet.com" })).toThrow(TypeError);
    expect(() => mailjet({ baseUrl: "https://user:pass@api.mailjet.com" })).toThrow(TypeError);
    expect(() => mailjet({ sandbox: "yes" as unknown as boolean })).toThrow(TypeError);
    expect(() => mailjet({ previousWebhookSecret: "short" })).toThrow(TypeError);
    expect(() => mailjet({ webhookUsername: "a:b" })).toThrow(TypeError);
  });

  it("maps a 401 with an HTML body to not_sent/auth and never copies the HTML", async () => {
    const { ctx } = context([answer(MAILJET_UNAUTHORIZED)]);
    const result = await mailjet().send(message(), ctx);
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "auth",
      httpStatus: 401,
      provider: "mailjet",
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("<");
    expect(text).not.toContain("Unauthorized");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET_KEY);
  });

  it("maps a 2xx with a body that is not JSON, or with no Messages array, to unknown", async () => {
    for (const body of ["<html>OK</html>", "", { Status: "success" }]) {
      const { ctx } = context([answer({ status: 200, body })]);
      expect(await mailjet().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
        provider: "mailjet",
      });
    }
  });

  it("keeps 500, 502, 503, and 504 unknown", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { ctx } = context([
        answer({ status, body: { ErrorIdentifier: "x", StatusCode: status, ErrorMessage: "e" } }),
      ]);
      expect(await mailjet().send(message(), ctx)).toMatchObject({
        status: "unknown",
        httpStatus: status,
      });
    }
  });

  it("maps a 429 to not_sent/rate_limited with no delay", async () => {
    const { ctx } = context([answer({ status: 429, body: "" })]);
    const result = await mailjet().send(message(), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "rate_limited" });
    expect(result.status === "not_sent" && result.retryAfterMs).toBeFalsy();
  });

  it("maps a global 400 error (mj-0002) to not_sent/invalid_message", async () => {
    const { ctx } = context([
      answer({
        status: 400,
        body: {
          ErrorIdentifier: "06df1144-c6f3-4ca7-8885-7ec5d4344113",
          ErrorCode: "mj-0002",
          ErrorMessage: "Malformed JSON, please review the syntax and properties types.",
          StatusCode: 400,
        },
      }),
    ]);
    expect(await mailjet().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
    });
  });

  it("maps an error entry with StatusCode 400 to not_sent and never copies ErrorMessage", async () => {
    const { ctx } = context([
      answer({ status: 400, body: mailjetAnswer(mailjetErrorEntry({ status: 400 })) }),
    ]);
    const result = await mailjet().send(message(), ctx);
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "invalid_message",
      httpStatus: 400,
    });
    expect(result.status === "not_sent" && result.message).toContain("mj-0013");
    expect(JSON.stringify(result)).not.toContain("not-an-address");
  });

  it("maps an error entry with StatusCode 403 send-0008 to not_sent/auth", async () => {
    const { ctx } = context([
      answer({
        status: 403,
        body: mailjetAnswer(mailjetErrorEntry({ status: 403, code: "send-0008" })),
      }),
    ]);
    expect(await mailjet().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "auth",
    });
  });

  it("keeps an error entry unknown for a 5xx or a missing StatusCode", async () => {
    const entries = [
      mailjetErrorEntry({ status: 500 }),
      mailjetErrorEntry({ status: 400 }, { status: 500 }),
      mailjetErrorEntry({}),
      { Status: "error", Errors: [] },
      { Status: "queued" },
    ];
    for (const entry of entries) {
      const { ctx } = context([answer({ status: 400, body: mailjetAnswer(entry) })]);
      expect(await mailjet().send(message(), ctx)).toMatchObject({
        status: "unknown",
        reason: "provider_error",
      });
    }
  });

  it("reads a success entry even with an HTTP 5xx", async () => {
    const { ctx } = context([
      answer({ status: 500, body: mailjetAnswer(mailjetSuccessEntry("ana@example.org")) }),
    ]);
    expect((await mailjet().send(message(), ctx)).status).toBe("sent");
  });

  it("gives unknown for a timeout and a network error", async () => {
    for (const response of ["timeout", "network"] as const) {
      const mock = mockFetch([{ label: "send", method: "POST", url: SEND_URL, response }]);
      const result = await mailjet().send(message(), {
        fetch: mock.fetch,
        timeoutMs: 5_000,
        credentials: { apiKey: KEY, secretKey: SECRET_KEY },
        now: NOW,
      });
      expect(result).toMatchObject({ status: "unknown", reason: response });
    }
  });

  it("refuses more than 50 recipients with no request", async () => {
    const { mock, ctx } = context([answer(echoSuccess)]);
    const to = Array.from({ length: 51 }, (_, index) => `r${index}@example.org`);
    expect(await mailjet().send(message({ to }), ctx)).toMatchObject({
      status: "not_sent",
      reason: "unsupported",
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses an email whose JSON entry is over 15 MB with no request", async () => {
    const { mock, ctx } = context([answer(echoSuccess)]);
    // Each quote becomes two characters in JSON.
    const html = '"'.repeat(7_600_000);
    const result = await mailjet().send(message({ html, text: undefined }), ctx);
    expect(result).toMatchObject({ status: "not_sent", reason: "unsupported" });
    expect(result.status === "not_sent" && result.message).toContain("Mailjet request body");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("mailjet sendBatch", () => {
  it("sends a batch of three in one request and gives three results in order", async () => {
    const { mock, ctx } = context([answer(echoSuccess)]);
    const messages = ["a", "b", "c"].map((name) => message({ to: [`${name}@example.org`] }));
    const results = await mailjet().sendBatch?.(messages, ctx);
    expect(mock.calls).toHaveLength(1);
    expect(
      sentBody(mock).Messages.map((item) => (item.To as { Email: string }[])[0]?.Email),
    ).toEqual(["a@example.org", "b@example.org", "c@example.org"]);
    expect(results?.map((result) => result.status === "sent" && result.providerMessageId)).toEqual([
      "uuid-0",
      "uuid-1",
      "uuid-2",
    ]);
  });

  it("gives sent, not_sent, sent when message 2 has a 400 error", async () => {
    const { ctx } = context([
      answer({
        status: 400,
        body: mailjetAnswer(
          mailjetSuccessEntry("a@example.org", "uuid-a"),
          mailjetErrorEntry({ status: 400 }),
          mailjetSuccessEntry("c@example.org", "uuid-c"),
        ),
      }),
    ]);
    const results = await mailjet().sendBatch?.([message(), message(), message()], ctx);
    expect(results?.map((result) => result.status)).toEqual(["sent", "not_sent", "sent"]);
    expect(results?.[1]).toMatchObject({ reason: "invalid_message", httpStatus: 400 });
  });

  it("gives sent and not_sent for an HTTP 400 with one success and one error entry", async () => {
    const { ctx } = context([
      answer({
        status: 400,
        body: mailjetAnswer(
          mailjetSuccessEntry("a@example.org"),
          mailjetErrorEntry({ status: 400 }),
        ),
      }),
    ]);
    const results = await mailjet().sendBatch?.([message(), message()], ctx);
    expect(results?.map((result) => result.status)).toEqual(["sent", "not_sent"]);
  });

  it("makes a 5xx entry and the missing entries unknown", async () => {
    const { ctx } = context([
      answer({
        status: 200,
        body: mailjetAnswer(
          mailjetSuccessEntry("a@example.org"),
          mailjetErrorEntry({ status: 503 }),
        ),
      }),
    ]);
    const results = await mailjet().sendBatch?.([message(), message(), message(), message()], ctx);
    expect(results?.map((result) => result.status)).toEqual([
      "sent",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("gives each message the result of a failed request", async () => {
    const { ctx } = context([answer(MAILJET_UNAUTHORIZED)]);
    const results = await mailjet().sendBatch?.([message(), message()], ctx);
    expect(results).toHaveLength(2);
    for (const result of results ?? []) {
      expect(result).toMatchObject({ status: "not_sent", reason: "auth" });
    }
    const network = mockFetch([
      { label: "send", method: "POST", url: SEND_URL, response: "network" },
    ]);
    const lost = await mailjet().sendBatch?.([message(), message()], {
      ...ctx,
      fetch: network.fetch,
    });
    expect(lost?.map((result) => result.status)).toEqual(["unknown", "unknown"]);
  });

  it("keeps a message that fails local validation in its own not_sent slot", async () => {
    const { mock, ctx } = context([answer(echoSuccess)]);
    const results = await mailjet().sendBatch?.(
      [
        message({ to: ["a@example.org"] }),
        message({ to: ["not-an-address"] }),
        message({ to: ["c@example.org"] }),
      ],
      ctx,
    );
    expect(results?.map((result) => result.status)).toEqual(["sent", "not_sent", "sent"]);
    expect(results?.[1]).toMatchObject({ reason: "invalid_message", provider: "mailjet" });
    expect(sentBody(mock).Messages).toHaveLength(2);
    expect(results?.[2]).toMatchObject({ providerMessageId: "uuid-1" });
  });

  it("makes no request when every message fails local validation", async () => {
    const { mock, ctx } = context([answer(echoSuccess)]);
    const results = await mailjet().sendBatch?.([message({ to: ["bad"] })], ctx);
    expect(results?.[0]?.status).toBe("not_sent");
    expect(mock.calls).toHaveLength(0);
  });

  it("splits two messages of 9 MB into two requests", async () => {
    const { mock, ctx } = context([answer(echoSuccess)]);
    const big = (name: string) =>
      message({
        to: [`${name}@example.org`],
        attachments: [
          {
            filename: `${name}.bin`,
            content: "A".repeat(9_000_000),
            contentType: "application/octet-stream",
          },
        ],
      });
    const results = await mailjet().sendBatch?.([big("a"), big("b")], ctx);
    expect(mock.calls).toHaveLength(2);
    for (const call of mock.calls) expect(utf8(call.body).length).toBeLessThan(15_000_000);
    expect(results?.map((result) => result.status)).toEqual(["sent", "sent"]);
  });

  it("refuses more than 50 messages as a programmer error", async () => {
    const { ctx } = context([answer(echoSuccess)]);
    const messages = Array.from({ length: 51 }, () => message());
    await expect(mailjet().sendBatch?.(messages, ctx)).rejects.toThrow(RangeError);
  });

  it("goes through the mailer in chunks of 50", async () => {
    const mock = mockFetch([answer(echoSuccess)]);
    const mailer = createMailer({
      providers: [{ adapter: mailjet(), credentials: { apiKey: KEY, secretKey: SECRET_KEY } }],
      fetch: mock.fetch,
      now: () => NOW,
      logger: { warn: () => {} },
    });
    const messages = Array.from({ length: 52 }, (_, index) =>
      message({ to: [`r${index}@example.org`] }),
    );
    const results = await mailer.sendBatch(messages);
    expect(mock.calls.map((call) => sentBody({ calls: [call] }).Messages.length)).toEqual([50, 2]);
    expect(results.every((result) => result.status === "sent")).toBe(true);
  });
});

describe("mailjet verify", () => {
  it("is ok for a 200 from GET /v3/REST/user and sends Basic auth", async () => {
    const { mock, ctx } = context([
      answer({ status: 200, body: { Count: 1, Data: [], Total: 1 } }, USER_URL, "GET"),
    ]);
    expect(await mailjet().verify(ctx)).toEqual({ ok: true });
    expect(mock.calls[0]?.headers.get("authorization")).toBe(BASIC);
  });

  it("maps a 401 to not_sent/auth and a 503 to unknown", async () => {
    const bad = context([answer(MAILJET_UNAUTHORIZED, USER_URL, "GET")]);
    expect(await mailjet().verify(bad.ctx)).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
    const down = context([answer({ status: 503, body: "" }, USER_URL, "GET")]);
    expect(await mailjet().verify(down.ctx)).toMatchObject({ ok: false, status: "unknown" });
  });
});

describe("mailjet webhooks", () => {
  const hooks = mailjet().webhooks;
  const verify = (headers: Headers, body: Uint8Array, secret = HOOK_SECRET) =>
    hooks.verify({ headers, body, secret, now: NOW });

  it("passes the right Basic header and parses a Version 2 list of three events", async () => {
    const body = utf8(
      JSON.stringify([
        mailjetEvent("sent"),
        mailjetEvent("bounce", { hard_bounce: true }),
        mailjetEvent("spam", { time: 1793102399 }),
      ]),
    );
    const sample = await signMailjetWebhook({ body, secret: HOOK_SECRET });
    expect(await verify(sample.headers, sample.body)).toEqual({ ok: true });
    const events = hooks.parse(sample.body, sample.headers);
    expect(events.map((event) => [event.type, event.bounce])).toEqual([
      ["delivered", undefined],
      ["bounced", "hard"],
      ["complained", undefined],
    ]);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(3);
    expect(hooks.parse(sample.body, sample.headers)).toEqual(events);
  });

  it("refuses a wrong password, another username, a missing header, and an empty secret", async () => {
    const body = utf8(JSON.stringify(mailjetEvent("sent")));
    const wrong = new Headers({ authorization: mailjetWebhookAuthorization(`${HOOK_SECRET}x`) });
    expect(await verify(wrong, body)).toEqual({ ok: false, reason: "bad_signature" });
    const user = new Headers({ authorization: mailjetWebhookAuthorization(HOOK_SECRET, "other") });
    expect(await verify(user, body)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify(new Headers(), body)).toEqual({ ok: false, reason: "bad_signature" });
    const right = new Headers({ authorization: mailjetWebhookAuthorization(HOOK_SECRET) });
    expect(await verify(right, body, "")).toEqual({ ok: false, reason: "bad_signature" });
    const broken = new Headers({ authorization: "Basic !!!" });
    expect(await verify(broken, body)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a body that is not an event object or a list of them", async () => {
    const headers = new Headers({ authorization: mailjetWebhookAuthorization(HOOK_SECRET) });
    for (const text of ["[]", "[1]", "null", '"sent"', "{"]) {
      expect(await verify(headers, utf8(text))).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("throws for a weak secret, which is a setup error", async () => {
    const headers = new Headers({ authorization: mailjetWebhookAuthorization("short") });
    await expect(verify(headers, utf8("{}"), "short")).rejects.toThrow(TypeError);
  });

  it("accepts the previous secret and a custom username during a rotation", async () => {
    const previous = generateMailjetWebhookSecret();
    const rotated = mailjet({ previousWebhookSecret: previous, webhookUsername: "hooks" }).webhooks;
    const body = utf8(JSON.stringify(mailjetEvent("sent")));
    for (const secret of [previous, HOOK_SECRET]) {
      const headers = new Headers({ authorization: mailjetWebhookAuthorization(secret, "hooks") });
      expect(await rotated.verify({ headers, body, secret: HOOK_SECRET, now: NOW })).toEqual({
        ok: true,
      });
    }
  });

  it("keeps every digit of 64-bit MessageIDs that round to one number", () => {
    const text = `[{"event":"sent","time":1,"MessageID":19421777835146490,"email":"a@example.org"},{"event":"sent","time":1,"MessageID":19421777835146491,"email":"a@example.org"}]`;
    const events = parseMailjetEvents("mailjet", utf8(text));
    expect(events.map((event) => event.providerMessageId)).toEqual([
      "19421777835146490",
      "19421777835146491",
    ]);
    expect(events[0]?.eventKey).not.toBe(events[1]?.eventKey);
  });

  it("skips an entry with no event name, keeps a repeated key once, and maps others to unknown", () => {
    const text = JSON.stringify([
      { time: 1, email: "a@example.org" },
      mailjetEvent("open"),
      mailjetEvent("open"),
      mailjetEvent("unsub"),
    ]);
    const events = parseMailjetEvents("mailjet", utf8(text));
    expect(events.map((event) => [event.type, event.rawType])).toEqual([
      ["unknown", "open"],
      ["unknown", "unsub"],
    ]);
    expect(parseMailjetEvents("mailjet", utf8("not json"))).toEqual([]);
  });

  it("builds the webhook URL with the username and the secret", () => {
    expect(mailjetWebhookUrl("https://app.example.com/hooks/mailjet", HOOK_SECRET)).toBe(
      `https://mailswitch:${HOOK_SECRET}@app.example.com/hooks/mailjet`,
    );
    expect(() => mailjetWebhookUrl("http://app.example.com/hooks", HOOK_SECRET)).toThrow(TypeError);
    expect(() => mailjetWebhookUrl("https://app.example.com/hooks", "short")).toThrow(TypeError);
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = mailjet();
    const body = utf8(JSON.stringify([mailjetEvent("bounce", { hard_bounce: false })]));
    const sample = await signMailjetWebhook({ body, secret: HOOK_SECRET });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/mailjet", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: HOOK_SECRET, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "soft" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });
});
