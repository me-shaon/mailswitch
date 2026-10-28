import { describe, expect, it } from "vitest";
import {
  bucketExpiry,
  bucketStartOf,
  DAILY_CAP_BUCKET_MS,
  DAILY_CAP_WINDOW_MS,
} from "../../src/core/daily-cap";
import type { BulkDailyCapStore } from "../../src/internal/bulk-methods";
import type { DailyCapReservation, DailyCapStore } from "../../src/stores/types";

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

/** A small seeded random number generator, so a failure repeats. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * The shared behavior of the optional bulk methods of a `DailyCapStore`. A store that
 * implements them must give the same results as its single methods in a loop.
 */
export function dailyCapBulkSuite(name: string, make: () => Promise<BulkDailyCapStore>): void {
  describe(`DailyCapStore bulk methods: ${name}`, () => {
    it("grants the first 3 of 5 units when 3 are left, and refuses 2 with the reset time", async () => {
      const store = await make();
      await reserveMany(store, "a", 5, T0, 2);
      const now = T0 + DAILY_CAP_BUCKET_MS + 7;
      const results = await store.reserveMany({ scope: "a", cap: 5, count: 5, now });
      const granted = { ok: true, bucketStart: T0 + DAILY_CAP_BUCKET_MS };
      const refused = { ok: false, resetAt: bucketExpiry(T0) };
      expect(results).toEqual([granted, granted, granted, refused, refused]);
      expect(await store.used("a", now)).toBe(5);
    });

    it("refuses every unit of a full window with the reset time of the oldest bucket", async () => {
      const store = await make();
      await reserveMany(store, "a", 2, T0, 1);
      await reserveMany(store, "a", 2, T0 + DAILY_CAP_BUCKET_MS, 1);
      const now = T0 + 3 * DAILY_CAP_BUCKET_MS;
      const results = await store.reserveMany({ scope: "a", cap: 2, count: 2, now });
      const refused = { ok: false, resetAt: bucketExpiry(T0) };
      expect(results).toEqual([refused, refused]);
      expect(await store.used("a", now)).toBe(2);
    });

    it("accepts a count of 0 and refuses a count that is not a non-negative integer", async () => {
      const store = await make();
      expect(await store.reserveMany({ scope: "a", cap: 2, count: 0, now: T0 })).toEqual([]);
      await expect(store.reserveMany({ scope: "a", cap: 2, count: -1, now: T0 })).rejects.toThrow(
        RangeError,
      );
      await expect(store.reserveMany({ scope: "a", cap: 2, count: 1.5, now: T0 })).rejects.toThrow(
        RangeError,
      );
      expect(await store.used("a", T0)).toBe(0);
    });

    it("refunds each bucket on releaseMany and never goes below zero", async () => {
      const store = await make();
      await reserveMany(store, "a", 10, T0, 2);
      await reserveMany(store, "a", 10, T0 + DAILY_CAP_BUCKET_MS, 1);
      await reserveMany(store, "b", 10, T0, 1);
      const later = T0 + 2 * DAILY_CAP_BUCKET_MS;
      await store.releaseMany([
        { scope: "a", bucketStart: T0, now: later },
        { scope: "a", bucketStart: T0 + DAILY_CAP_BUCKET_MS, now: later },
        { scope: "a", bucketStart: T0 + DAILY_CAP_BUCKET_MS, now: later },
        { scope: "b", bucketStart: T0, now: later },
        { scope: "b", bucketStart: T0, now: later },
      ]);
      expect(await store.used("a", later)).toBe(1);
      expect(await store.used("b", later)).toBe(0);
      // The bucket at T0 still holds one unit, so it sets the reset time.
      await reserveMany(store, "a", 2, later, 1);
      expect(await store.reserve({ scope: "a", cap: 2, now: later })).toEqual({
        ok: false,
        resetAt: bucketExpiry(T0),
      });
      await store.releaseMany([]);
    });

    it("gives the same results as reserve and release in a loop for random windows", async () => {
      const store = await make();
      const random = seeded(20_261_028);
      let partial = 0;
      for (let round = 0; round < 12; round++) {
        const cap = 1 + Math.floor(random() * 8);
        const start = T0 + round * 3 * DAILY_CAP_WINDOW_MS;
        // The same earlier units in both scopes: some in the window, some out of it.
        const earlier = Array.from({ length: Math.floor(random() * (cap + 2)) }, () =>
          Math.floor(random() * 300),
        );
        for (const scope of ["bulk", "loop"]) {
          for (const step of earlier) {
            await store.reserve({ scope, cap, now: start + step * DAILY_CAP_BUCKET_MS });
          }
        }
        const now = start + 300 * DAILY_CAP_BUCKET_MS + Math.floor(random() * 1000);
        const count = Math.floor(random() * (cap + 3));
        const bulk = await store.reserveMany({ scope: "bulk", cap, count, now });
        const loop: DailyCapReservation[] = [];
        for (let i = 0; i < count; i++) loop.push(await store.reserve({ scope: "loop", cap, now }));
        expect(bulk).toEqual(loop);
        expect(await store.used("bulk", now)).toBe(await store.used("loop", now));
        if (bulk.some((result) => result.ok) && bulk.some((result) => !result.ok)) partial++;

        const refunds = bulk.flatMap((result) =>
          result.ok && random() < 0.6 ? [result.bucketStart, result.bucketStart] : [],
        );
        await store.releaseMany(
          refunds.map((bucketStart) => ({ scope: "bulk", bucketStart, now })),
        );
        for (const bucketStart of refunds) await store.release({ scope: "loop", bucketStart, now });
        expect(await store.used("bulk", now)).toBe(await store.used("loop", now));
      }
      // The seed gives at least one partial grant.
      expect(partial).toBeGreaterThan(0);
    });
  });
}
