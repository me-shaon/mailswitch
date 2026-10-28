import { describe, expect, it } from "vitest";
import {
  bucketExpiry,
  bucketStartOf,
  DAILY_CAP_BUCKET_MS,
  DAILY_CAP_WINDOW_MS,
} from "../../src/core/daily-cap";
import type { DailyCapStore } from "../../src/stores/types";

// One suite for every DailyCapStore implementation.

/** A time at the start of a bucket, so tests can step inside one bucket. */
export const T0: number = bucketStartOf(1_800_000_000_000);

async function reserveMany(store: DailyCapStore, scope: string, cap: number, now: number, n = 1) {
  for (let i = 0; i < n; i++) {
    const result = await store.reserve({ scope, cap, now });
    expect(result.ok).toBe(true);
  }
}

export function dailyCapStoreSuite(name: string, make: () => Promise<DailyCapStore>): void {
  describe(`DailyCapStore: ${name}`, () => {
    it("reserves up to the cap, then refuses with the reset time of the oldest bucket", async () => {
      const store = await make();
      await reserveMany(store, "a", 3, T0, 2);
      await reserveMany(store, "a", 3, T0 + DAILY_CAP_BUCKET_MS, 1);
      const refused = await store.reserve({
        scope: "a",
        cap: 3,
        now: T0 + 2 * DAILY_CAP_BUCKET_MS,
      });
      expect(refused).toEqual({ ok: false, resetAt: bucketExpiry(T0) });
      expect(await store.used("a", T0 + 2 * DAILY_CAP_BUCKET_MS)).toBe(3);
    });

    it("returns the bucket start of a reservation", async () => {
      const store = await make();
      const result = await store.reserve({ scope: "a", cap: 3, now: T0 + 1234 });
      expect(result).toEqual({ ok: true, bucketStart: T0 });
    });

    it("frees room when the oldest bucket leaves the rolling window", async () => {
      const store = await make();
      await reserveMany(store, "a", 2, T0, 1);
      await reserveMany(store, "a", 2, T0 + DAILY_CAP_BUCKET_MS, 1);
      const resetAt = bucketExpiry(T0);
      expect(resetAt).toBe(T0 + DAILY_CAP_BUCKET_MS + DAILY_CAP_WINDOW_MS);
      expect((await store.reserve({ scope: "a", cap: 2, now: resetAt - 1 })).ok).toBe(false);
      expect((await store.reserve({ scope: "a", cap: 2, now: resetAt })).ok).toBe(true);
      expect((await store.reserve({ scope: "a", cap: 2, now: resetAt })).ok).toBe(false);
    });

    it("refunds one unit from the bucket of the reservation and never goes below zero", async () => {
      const store = await make();
      const first = await store.reserve({ scope: "a", cap: 2, now: T0 });
      await reserveMany(store, "a", 2, T0 + DAILY_CAP_BUCKET_MS, 1);
      if (!first.ok) throw new Error("expected a reservation");
      const later = T0 + 3 * DAILY_CAP_BUCKET_MS;
      await store.release({ scope: "a", bucketStart: first.bucketStart, now: later });
      expect(await store.used("a", later)).toBe(1);
      await store.release({ scope: "a", bucketStart: first.bucketStart, now: later });
      await store.release({ scope: "a", bucketStart: first.bucketStart, now: later });
      expect(await store.used("a", later)).toBe(1);
      // The refund went to the first bucket, so the reset time is the second bucket's.
      await reserveMany(store, "a", 2, later, 1);
      expect(await store.reserve({ scope: "a", cap: 2, now: later })).toEqual({
        ok: false,
        resetAt: bucketExpiry(T0 + DAILY_CAP_BUCKET_MS),
      });
    });

    it("fill makes the window full until the oldest bucket leaves", async () => {
      const store = await make();
      await reserveMany(store, "a", 10, T0, 3);
      const now = T0 + 2 * DAILY_CAP_BUCKET_MS;
      await store.fill({ scope: "a", cap: 10, now });
      expect(await store.used("a", now)).toBe(10);
      await store.fill({ scope: "a", cap: 10, now });
      expect(await store.used("a", now)).toBe(10);
      expect(await store.reserve({ scope: "a", cap: 10, now })).toEqual({
        ok: false,
        resetAt: bucketExpiry(T0),
      });
    });

    it("keeps scopes apart", async () => {
      const store = await make();
      await reserveMany(store, "a", 1, T0, 1);
      expect((await store.reserve({ scope: "a", cap: 1, now: T0 })).ok).toBe(false);
      expect((await store.reserve({ scope: "b", cap: 1, now: T0 })).ok).toBe(true);
    });

    it("gives the last unit to exactly one of 100 parallel reserves", async () => {
      const store = await make();
      // One fill call sets 99 used units. Sequential reserves here made the test slow
      // enough to time out on a busy machine.
      await store.fill({ scope: "a", cap: 99, now: T0 });
      const results = await Promise.all(
        Array.from({ length: 100 }, () => store.reserve({ scope: "a", cap: 100, now: T0 })),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await store.used("a", T0)).toBe(100);
    });
  });
}
