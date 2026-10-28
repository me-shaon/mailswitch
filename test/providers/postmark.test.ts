import { describe, expect, it } from "vitest";
import {
  POSTMARK_BOUNCE_DESCRIPTION,
  POSTMARK_FIXTURE_SECRET,
  POSTMARK_HARD_BOUNCE_DETAILS,
  postmarkBounce,
  postmarkDelivery,
  postmarkFixture,
  postmarkSubscriptionChange,
} from "../../src/conformance/fixtures/postmark";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import {
  checkPostmarkWebhookSecret,
  generatePostmarkWebhookSecret,
  POSTMARK_API_BASE,
  postmark,
  postmarkWebhookAuthorization,
} from "../../src/providers/postmark/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SEND_URL = `${POSTMARK_API_BASE}/email`;
const BATCH_URL = `${POSTMARK_API_BASE}/email/batch`;
const TOKEN = "0f8e5b3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRET = POSTMARK_FIXTURE_SECRET;
const NOW = Date.parse("2026-10-26T12:00:30.000Z");

function context(exchanges: RecordedExchange[], credentials: Record<string, string> = {}) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = {
    fetch: mock.fetch,
    timeoutMs: 5_000,
    credentials: { serverToken: TOKEN, ...credentials },
    now: NOW,
  };
  return { mock, ctx };
}

function exchange(url: string, status: number, body: unknown): RecordedExchange {
  return { label: `POST ${url} ${status}`, method: "POST", url, response: { status, body } };
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

function basic(user: string, pass: string, scheme = "Basic"): string {
  return `${scheme} ${bytesToBase64(utf8(`${user}:${pass}`))}`;
}

function verifyInput(authorization: string | null, body = postmarkBounce("ana@example.org")) {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  return { headers, body: utf8(body), secret: SECRET, now: NOW };
}

function webhookRequest(body: string, authorization = postmarkWebhookAuthorization(SECRET)) {
  return new Request("https://app.example.com/webhooks/postmark", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
  });
}

describe("postmark send", () => {
  it("maps attachments and headers to the Postmark shape and returns sent", async () => {
    const pdf = utf8("%PDF-1.7\n%mailswitch\n");
    const { mock, ctx } = context(
      [exchange(SEND_URL, 200, { ErrorCode: 0, Message: "OK", MessageID: "pm-1" })],
      { messageStream: "billing" },
    );
    const result = await postmark().send(
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
    expect(result).toEqual({ status: "sent", provider: "postmark", providerMessageId: "pm-1" });
    const call = mock.calls[0];
    expect(call?.headers.get("x-postmark-server-token")).toBe(TOKEN);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      From: "Acme Billing <billing@example.com>",
      To: 'ana@example.org, "Bo, Jr." <bo@example.org>',
      Cc: "Cy <cc@example.org>",
      Bcc: "bcc@example.org",
      ReplyTo: "Support <support@example.com>",
      Subject: "Your invoice",
      HtmlBody: "<p>Invoice attached.</p>",
      TextBody: "Invoice attached.",
      Headers: [{ Name: "X-Invoice", Value: "INV-1" }],
      Attachments: [
        { Name: "invoice.pdf", Content: bytesToBase64(pdf), ContentType: "application/pdf" },
        {
          Name: "logo.png",
          Content: bytesToBase64(utf8("png")),
          ContentType: "image/png",
          ContentID: "cid:logo",
        },
      ],
      MessageStream: "billing",
    });
  });

  it("sends no MessageStream when none is set and no idempotency key", async () => {
    const { mock, ctx } = context([exchange(SEND_URL, 200, { ErrorCode: 0, MessageID: "m" })]);
    await postmark().send(message({ idempotencyKey: "invoice-1" }), ctx);
    const body = JSON.parse(mock.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.MessageStream).toBeUndefined();
    expect([...(mock.calls[0]?.headers.values() ?? [])]).not.toContain("invoice-1");
  });

  it("refines a 422 by ErrorCode and keeps the body out of the result", async () => {
    const cases: [number, string][] = [
      [406, "rejected"],
      [412, "rejected"],
      [413, "auth"],
      [300, "invalid_message"],
    ];
    for (const [code, reason] of cases) {
      const { ctx } = context([
        exchange(SEND_URL, 422, { ErrorCode: code, Message: "secret-ish body text" }),
      ]);
      const result = await postmark().send(message(), ctx);
      expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: 422 });
      expect(JSON.stringify(result)).not.toContain("secret-ish");
    }
  });

  it("keeps a 500 and a 503 unknown", async () => {
    for (const status of [500, 503]) {
      const { ctx } = context([exchange(SEND_URL, status, { ErrorCode: 100 })]);
      expect(await postmark().send(message(), ctx)).toMatchObject({ status: "unknown" });
    }
  });

  it("maps each batch entry by its ErrorCode", async () => {
    const { ctx } = context([
      exchange(BATCH_URL, 200, [
        { ErrorCode: 0, MessageID: "a" },
        { ErrorCode: 406, Message: "inactive" },
        { ErrorCode: 101, Message: "unexpected" },
      ]),
    ]);
    const results = await postmark().sendBatch?.([message(), message(), message(), message()], ctx);
    expect(results).toEqual([
      { status: "sent", provider: "postmark", providerMessageId: "a" },
      expect.objectContaining({ status: "not_sent", reason: "rejected" }),
      expect.objectContaining({ status: "unknown" }),
      expect.objectContaining({ status: "unknown" }),
    ]);
  });
});

describe("postmark webhook auth", () => {
  const hooks = postmark().webhooks;

  it("accepts the right user and password with any case of the scheme", async () => {
    for (const scheme of ["Basic", "basic", "BASIC"]) {
      expect(await hooks.verify(verifyInput(basic("mailswitch", SECRET, scheme)))).toEqual({
        ok: true,
      });
    }
  });

  it("refuses the wrong user with the right password", async () => {
    expect(await hooks.verify(verifyInput(basic("someone", SECRET)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a wrong password, another scheme, and no header", async () => {
    const wrong = `${SECRET.slice(0, -1)}X`;
    expect(await hooks.verify(verifyInput(basic("mailswitch", wrong)))).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    expect(await hooks.verify(verifyInput(`Bearer ${SECRET}`))).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    expect(await hooks.verify(verifyInput(null))).toMatchObject({ reason: "bad_signature" });
    expect(await hooks.verify(verifyInput("Basic !!!"))).toMatchObject({ reason: "malformed" });
    expect(
      await hooks.verify(verifyInput(`Basic ${bytesToBase64(utf8("no-colon"))}`)),
    ).toMatchObject({ reason: "malformed" });
  });

  it("uses a configured username", async () => {
    const custom = postmark({ webhookUsername: "hooks" }).webhooks;
    expect(await custom.verify(verifyInput(basic("hooks", SECRET)))).toEqual({ ok: true });
    expect(await custom.verify(verifyInput(basic("mailswitch", SECRET)))).toMatchObject({
      ok: false,
    });
  });

  it("accepts the previous secret during a rotation", async () => {
    const previous = generatePostmarkWebhookSecret();
    const rotating = postmark({ previousWebhookSecret: previous }).webhooks;
    expect(await rotating.verify(verifyInput(basic("mailswitch", previous)))).toEqual({
      ok: true,
    });
    expect(await rotating.verify(verifyInput(basic("mailswitch", SECRET)))).toEqual({ ok: true });
    expect(await hooks.verify(verifyInput(basic("mailswitch", previous)))).toMatchObject({
      ok: false,
    });
  });

  it("requires 128 bits in the secret", async () => {
    expect(() => checkPostmarkWebhookSecret("a".repeat(21))).toThrow(/too short/);
    // 22 characters, not hex only.
    expect(() => checkPostmarkWebhookSecret(`abcdef0123456789${"x".repeat(6)}`)).not.toThrow();
    expect(() => checkPostmarkWebhookSecret("0123456789abcdef0123456789abcde")).toThrow(
      /too short/,
    );
    expect(() => checkPostmarkWebhookSecret("0123456789abcdef0123456789abcdef")).not.toThrow();
    expect(() => checkPostmarkWebhookSecret(`${"Ab-_".repeat(5)}zz`)).not.toThrow();
    expect(generatePostmarkWebhookSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      await hooks.verify({ ...verifyInput(basic("mailswitch", "short")), secret: "short" }),
    ).toEqual({ ok: false, reason: "invalid_secret" });
    expect(() => postmark({ previousWebhookSecret: "short" })).toThrow(/too short/);
    expect(() => postmark({ webhookUsername: "a:b" })).toThrow(/colon/);
  });

  it("keeps the secret out of a thrown error", async () => {
    const weak = "weak-secret-value";
    try {
      checkPostmarkWebhookSecret(weak);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(weak);
    }
  });
});

describe("postmark events through handleWebhook", () => {
  it("is marked as needing a dedupe store", () => {
    expect(postmark().requiresDedupe).toBe(true);
    expect(postmark().webhooks.signedTimestamp).toBe(false);
    const options = { adapter: postmark(), secret: SECRET };
    expect(() =>
      handleWebhook(
        webhookRequest("{}"),
        options as unknown as Parameters<typeof handleWebhook>[1],
      ),
    ).toThrow(/dedupe store/);
  });

  it("maps HardBounce to bounced/hard and drops a replay", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = postmark();
    const body = postmarkBounce("ana@example.org");
    const first = await handleWebhook(webhookRequest(body), {
      adapter,
      secret: SECRET,
      dedupe,
      now: () => NOW,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.events).toEqual([
      {
        type: "bounced",
        bounce: "hard",
        bounceDetail: { text: POSTMARK_HARD_BOUNCE_DETAILS },
        provider: "postmark",
        eventKey: "Bounce:692560173",
        rawType: "Bounce",
        recipient: "ana@example.org",
        providerMessageId: "883953f4-6105-42a2-a16a-77a8eac79483",
        occurredAt: Date.parse("2026-10-26T11:59:58Z"),
      },
    ]);
    await first.ack();
    const replay = await handleWebhook(webhookRequest(body), {
      adapter,
      secret: SECRET,
      dedupe,
      now: () => NOW + 1000,
    });
    expect(replay).toMatchObject({ ok: true, events: [] });
  });

  it("keeps two soft bounces of one message apart", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = postmark();
    const keys: string[] = [];
    for (const id of ["9007199254740993", "9007199254740995"]) {
      const outcome = await handleWebhook(
        webhookRequest(postmarkBounce("bo@example.org", "SoftBounce", id)),
        { adapter, secret: SECRET, dedupe, now: () => NOW },
      );
      if (!outcome.ok) throw new Error(outcome.rejection);
      expect(outcome.events).toHaveLength(1);
      keys.push(outcome.events[0]?.eventKey ?? "");
      await outcome.ack();
    }
    expect(keys).toEqual(["Bounce:9007199254740993", "Bounce:9007199254740995"]);
  });

  it("refuses the wrong user through handleWebhook", async () => {
    const outcome = await handleWebhook(
      webhookRequest(postmarkDelivery("ana@example.org"), basic("other", SECRET)),
      { adapter: postmark(), secret: SECRET, dedupe: new MemoryDedupeStore() },
    );
    expect(outcome).toMatchObject({ ok: false, rejection: "bad_signature", status: 401 });
  });

  it("gives the documented normalized events of every fixture sample", async () => {
    const fixture = postmarkFixture();
    const webhook = fixture.webhook;
    if (!webhook) throw new Error("no webhook fixture");
    const adapter = postmark();
    const dedupe = new MemoryDedupeStore();
    for (const sample of webhook.samples) {
      const body =
        typeof sample.body === "string" ? sample.body : new TextDecoder().decode(sample.body);
      const outcome = await handleWebhook(webhookRequest(body), {
        adapter,
        secret: SECRET,
        dedupe,
        now: () => NOW,
      });
      if (!outcome.ok) throw new Error(`${sample.label}: ${outcome.rejection}`);
      expect(outcome.events, sample.label).toHaveLength(sample.expected.length);
      sample.expected.forEach((want, index) => {
        expect(outcome.events[index], sample.label).toMatchObject(want);
      });
      await outcome.ack();
    }
  });
});

describe("postmark bounce detail", () => {
  const parse = (body: string) => postmark().webhooks?.parse(utf8(body), new Headers()) ?? [];

  it("reads Details when it is not empty", () => {
    expect(parse(postmarkBounce("ana@example.org"))[0]?.bounceDetail).toEqual({
      text: POSTMARK_HARD_BOUNCE_DETAILS,
    });
  });

  it("falls back to Description when Details is empty or blank", () => {
    for (const details of ["", "   "]) {
      const body = postmarkBounce("ana@example.org", "HardBounce", "1", "m-1", details);
      expect(parse(body)[0]?.bounceDetail).toEqual({ text: POSTMARK_BOUNCE_DESCRIPTION });
    }
  });

  it("gives no detail to a delivery", () => {
    expect(parse(postmarkDelivery("ana@example.org"))[0]?.bounceDetail).toBeUndefined();
  });
});

describe("postmark unsubscribe", () => {
  const MESSAGE_ID = "883953f4-6105-42a2-a16a-77a8eac79483";

  const parse = (body: string) => postmark().webhooks?.parse(utf8(body), new Headers()) ?? [];

  it("maps a recipient unsubscribe to unsubscribed", () => {
    const events = parse(postmarkSubscriptionChange("bo@example.org"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unsubscribed",
      recipient: "bo@example.org",
      providerMessageId: MESSAGE_ID,
      rawType: "SubscriptionChange",
      occurredAt: Date.parse("2026-10-26T12:00:05Z"),
    });
    expect(events[0]?.bounce).toBeUndefined();
  });

  it.each([
    ["a reactivation", { suppressSending: false }],
    ["a hard bounce suppression", { suppressionReason: "HardBounce" }],
    ["a spam complaint suppression", { suppressionReason: "SpamComplaint" }],
    ["a suppression by the customer", { origin: "Customer" }],
    ["a suppression by an admin", { origin: "Admin" }],
  ])("keeps %s as unknown", (_label, options) => {
    const events = parse(postmarkSubscriptionChange("bo@example.org", options));
    expect(events[0]).toMatchObject({ type: "unknown", rawType: "SubscriptionChange" });
  });

  it("gives a reactivation at the same time a different event key", () => {
    const [off] = parse(postmarkSubscriptionChange("bo@example.org"));
    const [on] = parse(postmarkSubscriptionChange("bo@example.org", { suppressSending: false }));
    expect(off?.eventKey).toBe(
      `SubscriptionChange:${MESSAGE_ID}:bo@example.org:2026-10-26T12:00:05Z:true`,
    );
    expect(on?.eventKey).toBe(
      `SubscriptionChange:${MESSAGE_ID}:bo@example.org:2026-10-26T12:00:05Z:false`,
    );
  });
});
