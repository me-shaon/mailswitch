// D1 query budgets. D1 limits the queries of one invocation, and one `db.batch` call counts
// as one query. Each test pins the exact count of one scenario, so a change that adds a
// store call fails here.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAILGUN_FIXTURE_SECRET,
  mailgunEvent,
  signMailgunWebhook,
} from "../../src/conformance/fixtures/mailgun";
import { toSendBounce } from "../../src/conformance/fixtures/tosend";
import { createMailer } from "../../src/index";
import { utf8 } from "../../src/internal/encoding";
import { mailgun } from "../../src/providers/mailgun/index";
import { tosend } from "../../src/providers/tosend/index";
import { toSendSignature } from "../../src/providers/tosend/webhooks";
import {
  applyD1Schema,
  D1DailyCapStore,
  D1DedupeStore,
  D1IdempotencyStore,
} from "../../src/stores/d1";
import { fakeProvider } from "../../src/testing/fake-provider";
import { handleWebhook } from "../../src/webhooks/index";
import { type CountingD1, countingD1 } from "./fixtures/counting-d1";

const db = (env as unknown as { DB: D1Database }).DB;
const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const TOSEND_SECRET = "tosend-webhook-secret-0123456789";

let counter: CountingD1;

beforeEach(async () => {
  await applyD1Schema(db);
  await db.batch([
    db.prepare("DELETE FROM mailswitch_idempotency"),
    db.prepare("DELETE FROM mailswitch_daily_cap"),
    db.prepare("DELETE FROM mailswitch_webhook_dedupe"),
  ]);
  counter = countingD1(db);
});

describe("the counting D1 wrapper", () => {
  it("counts a 4-statement batch as 1 query", async () => {
    const statements = [1, 2, 3, 4].map((n) => counter.db.prepare("SELECT ?1 AS n").bind(n));
    const results = await counter.db.batch(statements);
    expect(results).toHaveLength(4);
    expect(counter.count).toBe(1);
  });

  it("counts two single statements as 2 queries", async () => {
    await counter.db.prepare("SELECT 1 AS n").first();
    await counter.db.prepare("SELECT 2 AS n").all();
    expect(counter.count).toBe(2);
  });
});

describe("D1 queries for one send", () => {
  function mailer(outcomes: ("sent" | "not_sent")[]) {
    const primary = fakeProvider({ id: "a", outcomes });
    const backup = fakeProvider({ id: "b" });
    const mail = createMailer({
      providers: [
        { adapter: primary, credentials: { apiKey: "fk_a" }, dailyCap: 100 },
        { adapter: backup, credentials: { apiKey: "fk_b" }, dailyCap: 100 },
      ],
      namespace: "app",
      idempotency: new D1IdempotencyStore(counter.db),
      dailyCaps: new D1DailyCapStore(counter.db),
      now: () => NOW,
    });
    return { mail, primary, backup };
  }

  const message = {
    from: "billing@example.com",
    to: ["ana@example.org"],
    subject: "Invoice 42",
    text: "Body",
    idempotencyKey: "budget",
  };

  it("a keyed send through one provider with a daily cap costs 3 queries", async () => {
    const { mail, primary } = mailer(["sent"]);
    expect(await mail.send(message)).toMatchObject({ status: "sent", provider: "a" });
    expect(primary.sends).toHaveLength(1);
    expect(counter.count).toBe(3);
  });

  it("a keyed send with a not_sent primary and one fallback costs 6 queries", async () => {
    const { mail, backup } = mailer(["not_sent"]);
    expect(await mail.send(message)).toMatchObject({ status: "sent", provider: "b" });
    expect(backup.sends).toHaveLength(1);
    expect(counter.count).toBe(6);
  });
});

describe("D1 queries for one webhook request", () => {
  async function toSendRequest(events: number): Promise<Request> {
    const items = Array.from({ length: events }, (_, i) =>
      toSendBounce(`r${i}@example.org`, true, `msg-${i}`),
    );
    const bytes = utf8(events === 1 ? (items[0] as string) : `[${items.join(",")}]`);
    return new Request("https://app.test/webhooks/tosend", {
      method: "POST",
      headers: { "x-tosend-signature": await toSendSignature(TOSEND_SECRET, bytes) },
      body: bytes,
    });
  }

  for (const [events, queries] of [
    [1, 2],
    [10, 20],
    [120, 240],
    [1200, 2400],
  ] as const) {
    it(`a toSend body with ${events} events costs ${queries} queries`, async () => {
      const result = await handleWebhook(await toSendRequest(events), {
        adapter: tosend(),
        secret: TOSEND_SECRET,
        dedupe: new D1DedupeStore(counter.db),
        now: () => NOW,
      });
      if (!result.ok) throw new Error(result.rejection);
      expect(result.events).toHaveLength(events);
      await result.ack();
      expect(counter.count).toBe(queries);
    });
  }

  it("a Mailgun body with 1 event costs 4 queries", async () => {
    const sample = await signMailgunWebhook({
      body: utf8(mailgunEvent("failed", { severity: "permanent", reason: "bounce" })),
      secret: MAILGUN_FIXTURE_SECRET,
      at: NOW,
    });
    const request = new Request("https://app.test/webhooks/mailgun", {
      method: "POST",
      headers: sample.headers,
      body: sample.body,
    });
    const result = await handleWebhook(request, {
      adapter: mailgun(),
      secret: MAILGUN_FIXTURE_SECRET,
      dedupe: new D1DedupeStore(counter.db),
      now: () => NOW,
    });
    if (!result.ok) throw new Error(result.rejection);
    expect(result.events).toHaveLength(1);
    await result.ack();
    expect(counter.count).toBe(4);
  });
});
