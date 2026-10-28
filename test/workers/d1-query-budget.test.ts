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
import type { DailyCapStore, IdempotencyStore } from "../../src/stores/types";
import { fakeProvider } from "../../src/testing/fake-provider";
import { handleWebhook } from "../../src/webhooks/index";
import { batchProvider } from "../fixtures/batch-provider";
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

describe("D1 queries for one keyed sendBatch with a daily cap", () => {
  const NOT_SENT = { status: "not_sent", reason: "rejected", message: "Refused." } as const;

  function batchMailer(
    options: {
      size?: number;
      batchSize?: number;
      failing?: readonly string[];
      fallback?: boolean;
      idempotency?: IdempotencyStore;
      dailyCaps?: DailyCapStore;
    } = {},
  ) {
    const failing = new Set(options.failing ?? []);
    const primary = batchProvider({
      batchSize: options.batchSize ?? 100,
      outcome: (to) => (failing.has(to) ? NOT_SENT : undefined),
    });
    const backup = fakeProvider({ id: "b" });
    const mail = createMailer({
      providers: [
        { adapter: primary.adapter, credentials: { apiKey: "fk_a" }, dailyCap: 1000 },
        ...(options.fallback ? [{ adapter: backup, credentials: { apiKey: "fk_b" } }] : []),
      ],
      namespace: "app",
      idempotency: options.idempotency ?? new D1IdempotencyStore(counter.db),
      dailyCaps: options.dailyCaps ?? new D1DailyCapStore(counter.db),
      now: () => NOW,
    });
    const messages = Array.from({ length: options.size ?? 10 }, (_, i) => ({
      from: "billing@example.com",
      to: [`r${i}@example.org`],
      subject: `Invoice ${i}`,
      text: "Body",
      idempotencyKey: `batch-${i}`,
    }));
    return { mail, primary, backup, messages };
  }

  for (const [size, batchSize, queries] of [
    [10, 100, 4],
    [100, 100, 4],
    [250, 500, 12],
  ] as const) {
    it(`${size} messages with batch size ${batchSize}, all sent, cost ${queries} queries`, async () => {
      const { mail, primary, messages } = batchMailer({ size, batchSize });
      const results = await mail.sendBatch(messages);
      expect(results.every((r) => r.status === "sent")).toBe(true);
      expect(primary.batches.map((b) => b.length)).toEqual([size]);
      expect(counter.count).toBe(queries);
    });
  }

  it("10 messages with 2 not_sent and no fallback cost 5 queries", async () => {
    const { mail, messages } = batchMailer({ failing: ["r3@example.org", "r7@example.org"] });
    const results = await mail.sendBatch(messages);
    expect(results.filter((r) => r.status === "not_sent")).toHaveLength(2);
    expect(counter.count).toBe(5);
  });

  it("10 messages with 2 not_sent, each sent by a fallback with no cap, cost 8 queries", async () => {
    const { mail, backup, messages } = batchMailer({
      failing: ["r3@example.org", "r7@example.org"],
      fallback: true,
    });
    const results = await mail.sendBatch(messages);
    expect(results.every((r) => r.status === "sent")).toBe(true);
    expect(backup.sends).toHaveLength(2);
    expect(counter.count).toBe(8);
    const record = await new D1IdempotencyStore(db).get("app:batch-3");
    expect(record?.state).toBe("sent");
    expect(record?.attempts.map((a) => a.provider)).toEqual(["batcher", "b"]);
  });

  it("a D1 idempotency store with a cap store on the per-message path costs 13 queries", async () => {
    const caps = new D1DailyCapStore(counter.db);
    const dailyCaps: DailyCapStore = {
      reserve: (input) => caps.reserve(input),
      release: (input) => caps.release(input),
      fill: (input) => caps.fill(input),
      used: (scope, now) => caps.used(scope, now),
    };
    const { mail, messages } = batchMailer({ dailyCaps });
    const results = await mail.sendBatch(messages);
    expect(results.every((r) => r.status === "sent")).toBe(true);
    // 1 claim, 10 reserves, 1 heartbeat, 1 final record call.
    expect(counter.count).toBe(13);
    expect(await caps.used("batcher", NOW)).toBe(10);
  });

  it("a D1 cap store with an idempotency store on the per-message path costs 31 queries", async () => {
    const store = new D1IdempotencyStore(counter.db);
    const idempotency: IdempotencyStore = {
      claim: (input) => store.claim(input),
      touch: (input) => store.touch(input),
      finish: (input) => store.finish(input),
      release: (key, options) => store.release(key, options),
      get: (key) => store.get(key),
      purgeExpired: (now) => store.purgeExpired(now),
    };
    const { mail, messages } = batchMailer({ idempotency });
    const results = await mail.sendBatch(messages);
    expect(results.every((r) => r.status === "sent")).toBe(true);
    // 10 claims, 1 reserve, 10 heartbeats, 10 final records.
    expect(counter.count).toBe(31);
    expect((await new D1IdempotencyStore(db).get("app:batch-9"))?.state).toBe("sent");
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
    [10, 2],
    [120, 2],
    [1200, 6],
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

  it("a Mailgun body with 1 event costs 2 queries", async () => {
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
    expect(counter.count).toBe(2);
  });
});
