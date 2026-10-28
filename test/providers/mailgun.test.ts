import { describe, expect, it } from "vitest";
import {
  MAILGUN_FIXTURE_SECRET,
  MAILGUN_FIXTURE_SEND_URL,
  mailgunEvent,
  mailgunFixture,
  readMultipart,
  signMailgunWebhook,
} from "../../src/conformance/fixtures/mailgun";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import { sha256Hex } from "../../src/internal/sha256";
import {
  MAILGUN_MIN_DEDUPE_TTL_MS,
  MAILGUN_REGIONS,
  mailgun,
} from "../../src/providers/mailgun/index";
import { encodeMultipart, escapeDispositionValue } from "../../src/providers/mailgun/payload";
import { MemoryDedupeStore } from "../../src/stores/memory";
import type { DedupeStore } from "../../src/stores/types";
import { DEFAULT_LEASE_MS, handleWebhook, type WebhookAccepted } from "../../src/webhooks/index";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const KEY = "test-mailgun-api-key-not-a-real-secret";
const CREDENTIALS = { apiKey: KEY, domain: "mg.example.com", region: "us" };

function context(exchanges: RecordedExchange[], credentials: Record<string, string> = CREDENTIALS) {
  const mock = mockFetch(exchanges);
  const ctx: SendContext = { fetch: mock.fetch, timeoutMs: 5_000, credentials, now: NOW };
  return { mock, ctx };
}

function sendExchange(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
  url: string = MAILGUN_FIXTURE_SEND_URL,
): RecordedExchange {
  return {
    label: `send ${status}`,
    method: "POST",
    url,
    response: headers ? { status, body, headers } : { status, body },
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

const QUEUED = { id: "<20261026120030.1.4F2A9C@mg.example.com>", message: "Queued. Thank you." };

describe("mailgun send", () => {
  it("encodes a binary attachment as a multipart file part with exact bytes", async () => {
    const pdf = Uint8Array.from({ length: 256 }, (_, i) => i);
    const { mock, ctx } = context([sendExchange(200, QUEUED)]);
    const result = await mailgun().send(
      message({
        cc: [{ email: "cc@example.org", name: "Cy" }],
        bcc: ["bcc@example.org"],
        replyTo: "Support <support@example.com>",
        headers: { "X-Entity-Ref": "inv-42" },
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
      provider: "mailgun",
      providerMessageId: "20261026120030.1.4F2A9C@mg.example.com",
    });
    const call = mock.calls[0];
    if (!call) throw new Error("no request");
    expect(call.headers.get("content-type")).toMatch(
      /^multipart\/form-data; boundary=mailswitch-[0-9a-f]{32}$/,
    );
    expect(call.headers.get("authorization")).toBe(`Basic ${btoa(`api:${KEY}`)}`);
    expect(call.url).toBe(MAILGUN_FIXTURE_SEND_URL);
    expect(call.url).not.toContain(KEY);
    expect(call.body).toContain(
      'Content-Disposition: form-data; name="attachment"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n',
    );
    const parts = readMultipart(call);
    const file = parts.find((part) => part.name === "attachment");
    expect(file?.filename).toBe("invoice.pdf");
    expect(Array.from(file?.bytes ?? [])).toEqual(Array.from(pdf));
    const inline = parts.find((part) => part.name === "inline");
    expect(inline?.filename).toBe("logo");
    expect(new TextDecoder().decode(inline?.bytes)).toBe("png");
    const text = (name: string) =>
      parts
        .filter((part) => part.name === name)
        .map((part) => new TextDecoder().decode(part.bytes));
    expect(text("from")).toEqual(["Acme Billing <billing@example.com>"]);
    expect(text("to")).toEqual(["ana@example.org"]);
    expect(text("cc")).toEqual(["Cy <cc@example.org>"]);
    expect(text("bcc")).toEqual(["bcc@example.org"]);
    expect(text("h:Reply-To")).toEqual(["Support <support@example.com>"]);
    expect(text("h:X-Entity-Ref")).toEqual(["inv-42"]);
    expect(text("subject")).toEqual(["Your invoice"]);
  });

  it("escapes a quote, CR, and LF in Content-Disposition", () => {
    expect(escapeDispositionValue('a"b\r\nc')).toBe("a%22b%0D%0Ac");
    const body = new TextDecoder().decode(
      encodeMultipart(
        [
          {
            name: 'x"y',
            filename: 'evil".pdf\r\nX-Injected: 1',
            contentType: "application/pdf",
            bytes: utf8("z"),
          },
        ],
        "b",
      ),
    );
    expect(body).toBe(
      '--b\r\nContent-Disposition: form-data; name="x%22y"; filename="evil%22.pdf%0D%0AX-Injected: 1"\r\nContent-Type: application/pdf\r\n\r\nz\r\n--b--\r\n',
    );
  });

  it("uses the EU origin for the EU region, from options or credentials", async () => {
    const eu = `${MAILGUN_REGIONS.eu}/v3/mg.example.com/messages`;
    const first = context([sendExchange(200, QUEUED, undefined, eu)], {
      apiKey: KEY,
      domain: "mg.example.com",
    });
    expect((await mailgun({ region: "eu" }).send(message(), first.ctx)).status).toBe("sent");
    const second = context([sendExchange(200, QUEUED, undefined, eu)], {
      ...CREDENTIALS,
      region: "eu",
    });
    expect((await mailgun().send(message(), second.ctx)).status).toBe("sent");
  });

  it("classifies failures without copying the body", async () => {
    const cases: [RecordedExchange, Record<string, unknown>][] = [
      [sendExchange(401, "Forbidden"), { status: "not_sent", reason: "auth" }],
      [
        sendExchange(402, { message: "Request failed" }),
        { status: "not_sent", reason: "rejected" },
      ],
      [sendExchange(404, { message: "Domain not found" }), { status: "not_sent", reason: "auth" }],
      [sendExchange(500, "Internal Server Error"), { status: "unknown", reason: "provider_error" }],
      [
        sendExchange(
          429,
          { message: "Too many requests" },
          { "x-ratelimit-reset": String((NOW + 3000) / 1000) },
        ),
        { status: "not_sent", reason: "rate_limited", retryAfterMs: 3000 },
      ],
      [
        sendExchange(403, {
          message: "Domain mg.example.com is not allowed to send: daily limit reached",
        }),
        { status: "not_sent", reason: "quota" },
      ],
    ];
    for (const [exchange, expected] of cases) {
      const { ctx } = context([exchange]);
      const result = await mailgun().send(message(), ctx);
      expect(result).toMatchObject({ ...expected, provider: "mailgun" });
      expect(JSON.stringify(result)).not.toMatch(/Forbidden|limit reached|Too many/);
    }
  });

  it("refuses a missing domain with no request", async () => {
    const { mock, ctx } = context([], { apiKey: KEY });
    expect(await mailgun().send(message(), ctx)).toMatchObject({
      status: "not_sent",
      reason: "auth",
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws for invalid options", () => {
    expect(() => mailgun({ region: "ap" as "us" })).toThrow(TypeError);
    expect(() => mailgun({ baseUrl: "ftp://x" })).toThrow(TypeError);
    expect(() => mailgun({ baseUrl: "nope" })).toThrow(TypeError);
  });
});

function post(sample: { headers: Headers; body: Uint8Array }): Request {
  return new Request("https://app.test/webhooks/mailgun", {
    method: "POST",
    headers: sample.headers,
    body: sample.body,
  });
}

async function signed(data: string, at = NOW, token?: string) {
  return post(
    await signMailgunWebhook({
      body: utf8(data),
      secret: MAILGUN_FIXTURE_SECRET,
      at,
      ...(token ? { token } : {}),
    }),
  );
}

function accepted(outcome: Awaited<ReturnType<typeof handleWebhook>>): WebhookAccepted {
  if (!outcome.ok) throw new Error(`Refused: ${outcome.rejection}`);
  return outcome;
}

const BOUNCE = mailgunEvent("failed", { severity: "permanent", reason: "bounce" });
const TOKEN = "a".repeat(50);

describe("mailgun webhooks through handleWebhook", () => {
  it("is marked as needing a dedupe store and binding keys to the body", () => {
    const adapter = mailgun();
    expect(adapter.requiresDedupe).toBe(true);
    expect(adapter.bodyBoundKeys).toBe(true);
    expect(adapter.webhooks.signedTimestamp).toBe(true);
    expect(MAILGUN_MIN_DEDUPE_TTL_MS).toBe(12 * 60 * 1000);
  });

  it("gives the documented normalized events for each fixture sample", async () => {
    const fixture = mailgunFixture();
    for (const sample of fixture.webhook?.samples ?? []) {
      const outcome = accepted(
        await handleWebhook(await signed(sample.body as string), {
          adapter: mailgun(),
          secret: MAILGUN_FIXTURE_SECRET,
          dedupe: new MemoryDedupeStore(),
          now: () => NOW,
        }),
      );
      expect(outcome.events).toHaveLength(sample.expected.length);
      outcome.events.forEach((event, index) => {
        expect(event).toMatchObject({ provider: "mailgun", ...sample.expected[index] });
        expect(event.eventKey).toMatch(/^[0-9a-f]{50}$/);
      });
    }
  });

  it("refuses a reused token with a different body, after ack and while in flight", async () => {
    const dedupe = new MemoryDedupeStore();
    const options = { adapter: mailgun(), secret: MAILGUN_FIXTURE_SECRET, dedupe, now: () => NOW };
    const first = accepted(await handleWebhook(await signed(BOUNCE, NOW, TOKEN), options));
    expect(first.events).toHaveLength(1);
    const changed = mailgunEvent("delivered", {}, "eve@example.org");

    // While the first request holds the lease.
    expect(await handleWebhook(await signed(changed, NOW, TOKEN), options)).toMatchObject({
      ok: false,
      rejection: "bad_signature",
      status: 401,
    });
    await first.ack();
    // After the commit.
    expect(await handleWebhook(await signed(changed, NOW, TOKEN), options)).toMatchObject({
      ok: false,
      rejection: "bad_signature",
    });
    // The refusals freed their body key, and the original replay stays a duplicate.
    const replay = accepted(await handleWebhook(await signed(BOUNCE, NOW, TOKEN), options));
    expect(replay.events).toEqual([]);
  });

  it("delivers a same-body retry again after the lease expires", async () => {
    let clock = NOW;
    const options = {
      adapter: mailgun(),
      secret: MAILGUN_FIXTURE_SECRET,
      dedupe: new MemoryDedupeStore(),
      now: () => clock,
    };
    const first = accepted(await handleWebhook(await signed(BOUNCE, NOW, TOKEN), options));
    expect(first.events).toHaveLength(1);
    // No ack: the app failed. A retry inside the lease is in flight.
    expect(await handleWebhook(await signed(BOUNCE, NOW, TOKEN), options)).toMatchObject({
      ok: false,
      rejection: "in_flight",
    });
    clock = NOW + DEFAULT_LEASE_MS + 1;
    const retry = accepted(await handleWebhook(await signed(BOUNCE, NOW, TOKEN), options));
    expect(retry.events).toHaveLength(1);
    expect(retry.events[0]?.eventKey).toBe(TOKEN);
  });

  it("refuses a timestamp 6 minutes old or 2 minutes in the future", async () => {
    const options = {
      adapter: mailgun(),
      secret: MAILGUN_FIXTURE_SECRET,
      dedupe: new MemoryDedupeStore(),
      now: () => NOW,
    };
    for (const at of [NOW - 6 * 60 * 1000, NOW + 2 * 60 * 1000]) {
      expect(await handleWebhook(await signed(BOUNCE, at), options)).toMatchObject({
        ok: false,
        rejection: "stale",
      });
    }
    for (const at of [NOW - 4 * 60 * 1000, NOW + 30 * 1000]) {
      expect((await handleWebhook(await signed(BOUNCE, at), options)).ok).toBe(true);
    }
  });

  it("refuses a wrong signature, a wrong content type, and a missing signature", async () => {
    const options = {
      adapter: mailgun(),
      secret: MAILGUN_FIXTURE_SECRET,
      dedupe: new MemoryDedupeStore(),
      now: () => NOW,
    };
    const sample = await signMailgunWebhook({ body: utf8(BOUNCE), secret: "other-key", at: NOW });
    expect(await handleWebhook(post(sample), options)).toMatchObject({
      rejection: "bad_signature",
    });
    const good = await signMailgunWebhook({
      body: utf8(BOUNCE),
      secret: MAILGUN_FIXTURE_SECRET,
      at: NOW,
    });
    const form = {
      headers: new Headers({ "content-type": "multipart/form-data" }),
      body: good.body,
    };
    expect(await handleWebhook(post(form), options)).toMatchObject({ rejection: "malformed" });
    const bare = { headers: good.headers, body: utf8(`{"event-data":${BOUNCE}}`) };
    expect(await handleWebhook(post(bare), options)).toMatchObject({ rejection: "bad_signature" });
  });

  it("throws at setup without a dedupe store or with a short TTL", async () => {
    const request = await signed(BOUNCE);
    expect(() =>
      // @ts-expect-error Mailgun needs a dedupe store.
      handleWebhook(request, { adapter: mailgun(), secret: MAILGUN_FIXTURE_SECRET }),
    ).toThrow(/needs a dedupe store/);
    expect(() =>
      handleWebhook(request, {
        adapter: mailgun(),
        secret: MAILGUN_FIXTURE_SECRET,
        dedupe: new MemoryDedupeStore(),
        ttlMs: MAILGUN_MIN_DEDUPE_TTL_MS - 1,
      }),
    ).toThrow(/ttlMs must be at least/);
  });

  it("claims the token alone and with the body hash", async () => {
    const inner = new MemoryDedupeStore();
    const keys: string[] = [];
    const dedupe: DedupeStore = {
      claim: (input) => {
        keys.push(input.key);
        return inner.claim(input);
      },
      commit: (input) => inner.commit(input),
      release: (input) => inner.release(input),
      purgeExpired: (now) => inner.purgeExpired(now),
    };
    const sample = await signMailgunWebhook({
      body: utf8(BOUNCE),
      secret: MAILGUN_FIXTURE_SECRET,
      at: NOW,
      token: TOKEN,
    });
    accepted(
      await handleWebhook(post(sample), {
        adapter: mailgun(),
        secret: MAILGUN_FIXTURE_SECRET,
        dedupe,
        now: () => NOW,
      }),
    );
    expect(keys).toEqual([
      `mailgun:default:${TOKEN}`,
      `mailgun:default:${TOKEN}#${sha256Hex(sample.body)}`,
    ]);
  });
});

describe("mailgun bounce detail", () => {
  async function parseSigned(body: string) {
    const sample = await signMailgunWebhook({
      body: utf8(body),
      secret: MAILGUN_FIXTURE_SECRET,
      at: NOW,
    });
    return mailgun().webhooks?.parse(sample.body, new Headers(sample.headers)) ?? [];
  }

  it("leaves out enhancedCode when a temporary failure has a null enhanced-code", async () => {
    const events = await parseSigned(
      mailgunEvent("failed", {
        severity: "temporary",
        reason: "generic",
        "delivery-status": { code: 421, "enhanced-code": null, message: "421 try again later" },
      }),
    );
    expect(events[0]?.bounceDetail).toEqual({ text: "421 try again later", smtpCode: 421 });
  });

  it("uses description when message is empty", async () => {
    const events = await parseSigned(
      mailgunEvent("failed", {
        severity: "permanent",
        reason: "bounce",
        "delivery-status": {
          code: 605,
          message: "",
          description: "Not delivering to previously bounced address",
        },
      }),
    );
    // 605 is not an SMTP code, so the builder drops it.
    expect(events[0]?.bounceDetail).toEqual({
      text: "Not delivering to previously bounced address",
    });
  });

  it("gives no detail to a delivery or a complaint", async () => {
    const delivered = await parseSigned(
      mailgunEvent("delivered", { "delivery-status": { code: 250, message: "OK" } }),
    );
    expect(delivered[0]?.bounceDetail).toBeUndefined();
    expect((await parseSigned(mailgunEvent("complained")))[0]?.bounceDetail).toBeUndefined();
  });
});

describe("mailgun unsubscribe", () => {
  async function parseSigned(body: string) {
    const sample = await signMailgunWebhook({
      body: utf8(body),
      secret: MAILGUN_FIXTURE_SECRET,
      at: NOW,
    });
    return mailgun().webhooks?.parse(sample.body, new Headers(sample.headers)) ?? [];
  }

  it("maps an unsubscribed event to unsubscribed", async () => {
    const events = await parseSigned(mailgunEvent("unsubscribed", {}, "bo@example.org"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unsubscribed",
      recipient: "bo@example.org",
      providerMessageId: "20261026120030.1.4F2A9C@mg.example.com",
      rawType: "unsubscribed",
    });
    expect(events[0]?.bounce).toBeUndefined();
    expect(events[0]?.bounceDetail).toBeUndefined();
  });

  it("keeps a drop after an earlier unsubscribe as unknown", async () => {
    const events = await parseSigned(
      mailgunEvent("failed", { severity: "permanent", reason: "suppress-unsubscribe" }),
    );
    expect(events[0]).toMatchObject({ type: "unknown", rawType: "failed" });
  });
});
