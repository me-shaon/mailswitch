import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { SENT_RETENTION_MS } from "../../src/core/idempotency";
import { createMailer } from "../../src/index";
import {
  type DurableObjectNamespaceLike,
  durableObjectDailyCapStore,
  durableObjectIdempotencyStore,
  durableObjectRateLimitStore,
} from "../../src/stores/durable-object";
import type { IdempotencyRecord } from "../../src/stores/types";
import { fakeProvider } from "../../src/testing/fake-provider";
import { dailyCapStoreSuite, T0 } from "../stores/daily-cap-suite";
import { idempotencyStoreSuite } from "../stores/store-suite";

const bindings = env as unknown as {
  LIMITER: DurableObjectNamespace;
  IDEMPOTENCY: DurableObjectNamespace;
};

let run = 0;

/** A namespace view with a fresh name prefix, so each test gets new objects. */
function fresh(namespace: DurableObjectNamespace): DurableObjectNamespaceLike<DurableObjectId> {
  const prefix = `run-${++run}:`;
  return {
    idFromName: (name) => namespace.idFromName(prefix + name),
    get: (id) => namespace.get(id),
  };
}

function stubFor(namespace: DurableObjectNamespaceLike<DurableObjectId>, name: string) {
  return namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub;
}

idempotencyStoreSuite("Durable Object", async () => {
  const namespace = fresh(bindings.IDEMPOTENCY);
  const store = durableObjectIdempotencyStore(namespace);
  return {
    store,
    rawRow: (key) =>
      runInDurableObject(stubFor(namespace, key), (_instance, state) =>
        state.storage.get("record"),
      ),
    purge: async (now, keys) => {
      let deleted = 0;
      for (const key of keys) if (await store.purgeKey(key, now)) deleted++;
      return deleted;
    },
  };
});

dailyCapStoreSuite("Durable Object", async () =>
  durableObjectDailyCapStore(fresh(bindings.LIMITER)),
);

const message = {
  from: "billing@example.com",
  to: ["ana@example.org"],
  subject: "Hi",
  text: "Body",
};

describe("Durable Object rate limit store", () => {
  it("takes the burst, then refuses with the wait for the next token", async () => {
    const store = durableObjectRateLimitStore(fresh(bindings.LIMITER));
    const input = { scope: "a", ratePerSecond: 2, burst: 2, now: T0 };
    expect(await store.acquire(input)).toEqual({ ok: true });
    expect(await store.acquire(input)).toEqual({ ok: true });
    expect(await store.acquire(input)).toEqual({ ok: false, retryAfterMs: 500 });
    expect(await store.acquire({ ...input, now: T0 + 500 })).toEqual({ ok: true });
    expect(await store.acquire({ ...input, scope: "b" })).toEqual({ ok: true });
  });

  it("gives the last token to exactly one of 20 parallel calls", async () => {
    const store = durableObjectRateLimitStore(fresh(bindings.LIMITER));
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.acquire({ scope: "a", ratePerSecond: 1, burst: 1, now: T0 }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("refuses a burst over the rate and refunds the cap unit, on one limiter object", async () => {
    const namespace = fresh(bindings.LIMITER);
    const dailyCaps = durableObjectDailyCapStore(namespace);
    const fake = fakeProvider();
    const mailer = createMailer({
      providers: [
        { adapter: fake, credentials: { apiKey: "fk_a" }, dailyCap: 10, rate: { perSecond: 1 } },
      ],
      dailyCaps,
      rateLimits: durableObjectRateLimitStore(namespace),
      now: () => T0,
    });
    expect((await mailer.send(message)).status).toBe("sent");
    expect(await mailer.send(message)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 1000,
    });
    expect(fake.sends).toHaveLength(1);
    expect(await dailyCaps.used("fake", T0)).toBe(1);
  });
});

describe("MailswitchIdempotency alarm", () => {
  it("deletes an expired sent record and keeps an unknown record", async () => {
    const namespace = fresh(bindings.IDEMPOTENCY);
    const store = durableObjectIdempotencyStore(namespace);
    const now = Date.now();
    for (const [key, state] of [
      ["sent", "sent"],
      ["unknown", "unknown"],
    ] as const) {
      await store.claim({ key, payloadHash: "h", claimId: "c", now, pendingTimeoutMs: 1000 });
      await store.finish({
        key,
        claimId: "c",
        state,
        attempts: [{ provider: "fake", status: state, at: now }],
        now,
        expiresAt: now + 50,
      });
    }
    expect((await store.get("sent"))?.state).toBe("sent");
    // The alarm of the sent record runs on its own after `expiresAt`.
    await vi.waitFor(async () => expect(await store.get("sent")).toBeNull(), {
      timeout: 2000,
      interval: 20,
    });
    // An unknown record sets no alarm and stays.
    expect(await runDurableObjectAlarm(stubFor(namespace, "unknown"))).toBe(false);
    expect((await store.get("unknown"))?.state).toBe("unknown");
  });

  it("sets the alarm again when a record is not due, and keeps a pending record", async () => {
    const namespace = fresh(bindings.IDEMPOTENCY);
    const store = durableObjectIdempotencyStore(namespace);
    const now = Date.now();
    await store.claim({ key: "k", payloadHash: "h", claimId: "c", now, pendingTimeoutMs: 1000 });
    await store.finish({
      key: "k",
      claimId: "c",
      state: "sent",
      attempts: [],
      now,
      expiresAt: now + SENT_RETENTION_MS,
    });
    const stub = stubFor(namespace, "k");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await store.get("k"))?.state).toBe("sent");
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(now + SENT_RETENTION_MS + 1);
    // A pending record at any age stays when the alarm runs.
    await runInDurableObject(stub, async (_instance, state) => {
      const record = (await state.storage.get<IdempotencyRecord>("record")) as IdempotencyRecord;
      await state.storage.put("record", { ...record, state: "pending", expiresAt: 0 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await store.get("k"))?.state).toBe("pending");
  });

  it("returns 0 from purgeExpired and refuses a value that is not a binding", async () => {
    const store = durableObjectIdempotencyStore(fresh(bindings.IDEMPOTENCY));
    expect(await store.purgeExpired(Date.now())).toBe(0);
    expect(() => durableObjectIdempotencyStore({} as never)).toThrow(TypeError);
    expect(() => durableObjectDailyCapStore({} as never)).toThrow(TypeError);
    expect(() => durableObjectRateLimitStore({} as never)).toThrow(TypeError);
  });
});
