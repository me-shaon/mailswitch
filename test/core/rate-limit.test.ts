import { describe, expect, it } from "vitest";
import { defineProvider, type ProviderAdapter } from "../../src/core/adapter";
import { defineProviderMeta } from "../../src/core/meta";
import { createMailer, type MailerOptions, type MailerProvider } from "../../src/core/pipeline";
import { checkRate, takeToken } from "../../src/core/rate-limit";
import type { OutgoingMessage } from "../../src/core/types";
import {
  MemoryDailyCapStore,
  MemoryIdempotencyStore,
  MemoryRateLimitStore,
} from "../../src/stores/memory";
import type { RateLimitStore } from "../../src/stores/types";
import { fakeMeta, fakeProvider } from "../../src/testing/fake-provider";
import { T0 } from "../stores/daily-cap-suite";

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: "billing@example.com",
    to: ["ana@example.org"],
    subject: "Hi",
    text: "Body",
    ...overrides,
  };
}

describe("token bucket math", () => {
  it("starts full, takes one token per call, and refills at the rate", () => {
    let state = takeToken(undefined, 2, 3, T0);
    expect(state.grant).toEqual({ ok: true });
    expect(state.bucket).toEqual({ tokens: 2, updatedAt: T0 });
    state = takeToken(state.bucket, 2, 3, T0);
    state = takeToken(state.bucket, 2, 3, T0);
    expect(state.grant).toEqual({ ok: true });
    state = takeToken(state.bucket, 2, 3, T0 + 100);
    // 0.2 tokens after 100 ms: the next token is 400 ms away.
    expect(state.grant).toEqual({ ok: false, retryAfterMs: 400 });
    expect(takeToken(state.bucket, 2, 3, T0 + 500).grant).toEqual({ ok: true });
    // The bucket never holds more than the burst.
    expect(takeToken({ tokens: 0, updatedAt: T0 }, 2, 3, T0 + 60_000).bucket.tokens).toBe(2);
  });

  it("checks the rate option and defaults the burst", () => {
    expect(checkRate({ perSecond: 5 }, "t")).toEqual({ perSecond: 5, burst: 5 });
    expect(checkRate({ perSecond: 0.5 }, "t")).toEqual({ perSecond: 0.5, burst: 1 });
    expect(checkRate({ perSecond: 2, burst: 10 }, "t")).toEqual({ perSecond: 2, burst: 10 });
    for (const rate of [
      { perSecond: 0 },
      { perSecond: Number.NaN },
      { perSecond: 1, burst: 0.5 },
    ]) {
      expect(() => checkRate(rate, "t")).toThrow(RangeError);
    }
  });
});

describe("MemoryRateLimitStore", () => {
  it("keeps scopes apart", async () => {
    const store = new MemoryRateLimitStore();
    const input = { scope: "a", ratePerSecond: 1, burst: 1, now: T0 };
    expect(await store.acquire(input)).toEqual({ ok: true });
    expect(await store.acquire(input)).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(await store.acquire({ ...input, scope: "b" })).toEqual({ ok: true });
  });
});

function provider(extra: Partial<MailerProvider> = {}, id = "fake") {
  const adapter = fakeProvider({ id });
  return { adapter, entry: { adapter, credentials: { apiKey: "fk_a" }, ...extra } };
}

function mailer(providers: MailerProvider[], extra: Partial<MailerOptions> = {}) {
  return createMailer({ providers, now: () => T0, logger: { warn: () => {} }, ...extra });
}

describe("createMailer: rate limits", () => {
  it("refuses a burst over the rate with not_sent/rate_limited and retryAfterMs", async () => {
    const { adapter, entry } = provider({ rate: { perSecond: 2 } });
    const send = mailer([entry], { rateLimits: new MemoryRateLimitStore() });
    expect((await send.send(message())).status).toBe("sent");
    expect((await send.send(message())).status).toBe("sent");
    expect(await send.send(message())).toEqual({
      status: "not_sent",
      reason: "rate_limited",
      message: "The rate limit of the provider is reached.",
      retryAfterMs: 500,
      provider: "fake",
    });
    expect(adapter.sends).toHaveLength(2);
  });

  it("refunds the cap unit of an attempt that the rate limit refuses", async () => {
    const dailyCaps = new MemoryDailyCapStore();
    const { adapter, entry } = provider({ dailyCap: 5, rate: { perSecond: 1 } });
    const send = mailer([entry], { dailyCaps, rateLimits: new MemoryRateLimitStore() });
    await send.send(message());
    for (let i = 0; i < 4; i++) {
      expect(await send.send(message())).toMatchObject({ reason: "rate_limited" });
    }
    expect(adapter.sends).toHaveLength(1);
    expect(await dailyCaps.used("fake", T0)).toBe(1);
  });

  it("refunds the cap unit and writes the final state when the rate limit store throws", async () => {
    const dailyCaps = new MemoryDailyCapStore();
    const idempotency = new MemoryIdempotencyStore();
    const broken: RateLimitStore = {
      acquire: async () => {
        throw new Error("store down");
      },
    };
    const { adapter, entry } = provider({ dailyCap: 5, rate: { perSecond: 1 } });
    const send = mailer([entry], { dailyCaps, rateLimits: broken, idempotency, namespace: "app" });
    expect(await send.send(message({ idempotencyKey: "k" }))).toMatchObject({
      status: "not_sent",
      reason: "store_error",
    });
    expect(adapter.sends).toHaveLength(0);
    expect(await dailyCaps.used("fake", T0)).toBe(0);
    expect((await idempotency.get("app:k"))?.state).toBe("not_sent");
  });

  it("falls back to the next provider after a rate limit refusal", async () => {
    const primary = provider({ rate: { perSecond: 1 } });
    const backup = provider({}, "backup");
    const send = mailer([primary.entry, backup.entry], {
      rateLimits: new MemoryRateLimitStore(),
    });
    await send.send(message());
    expect(await send.send(message())).toMatchObject({ status: "sent", provider: "backup" });
    expect(primary.adapter.sends).toHaveLength(1);
    expect(backup.adapter.sends).toHaveLength(1);
  });

  it("writes not_sent for a keyed send that the rate limit refuses", async () => {
    const idempotency = new MemoryIdempotencyStore();
    const { entry } = provider({ rate: { perSecond: 1 } });
    const send = mailer([entry], {
      rateLimits: new MemoryRateLimitStore(),
      idempotency,
      namespace: "app",
    });
    await send.send(message({ idempotencyKey: "a" }));
    expect(await send.send(message({ idempotencyKey: "b" }))).toMatchObject({
      reason: "rate_limited",
    });
    expect((await idempotency.get("app:b"))?.state).toBe("not_sent");
  });

  it("takes one token per message before a batch request", async () => {
    const base = fakeMeta("batcher");
    const batches: OutgoingMessage[][] = [];
    const adapter: ProviderAdapter = defineProvider({
      meta: defineProviderMeta({ ...base, capabilities: { ...base.capabilities, batchSize: 10 } }),
      async send() {
        return { status: "sent" };
      },
      async sendBatch(list) {
        batches.push([...list]);
        return list.map(() => ({ status: "sent" as const }));
      },
      async verify() {
        return { ok: true };
      },
      webhooks: fakeProvider().webhooks,
    });
    const dailyCaps = new MemoryDailyCapStore();
    const send = mailer(
      [{ adapter, credentials: { apiKey: "fk_a" }, dailyCap: 10, rate: { perSecond: 2 } }],
      { dailyCaps, rateLimits: new MemoryRateLimitStore() },
    );
    const results = await send.sendBatch([
      message({ to: ["a@x.org"] }),
      message({ to: ["b@x.org"] }),
      message({ to: ["c@x.org"] }),
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(results.map((result) => result.status)).toEqual(["sent", "sent", "not_sent"]);
    expect(results[2]).toMatchObject({ reason: "rate_limited", retryAfterMs: 500 });
    expect(await dailyCaps.used("batcher", T0)).toBe(2);
  });

  it("refuses invalid rate options", () => {
    const { entry } = provider({ rate: { perSecond: 1 } });
    expect(() => mailer([entry])).toThrow(/no rateLimits store/);
    const bad = provider({ rate: { perSecond: -1 } });
    expect(() => mailer([bad.entry], { rateLimits: new MemoryRateLimitStore() })).toThrow(
      RangeError,
    );
    const twin = provider({ rate: { perSecond: 1 }, scope: "fake" }, "other");
    expect(() => mailer([entry, twin.entry], { rateLimits: new MemoryRateLimitStore() })).toThrow(
      /used twice/,
    );
  });
});
