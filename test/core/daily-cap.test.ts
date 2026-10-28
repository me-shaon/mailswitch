import { describe, expect, it } from "vitest";
import {
  bucketExpiry,
  bucketStartOf,
  checkDailyCap,
  DAILY_CAP_BUCKET_MS,
  windowFloor,
} from "../../src/core/daily-cap";
import { MemoryDailyCapStore } from "../../src/stores/memory";
import { dailyCapBulkSuite, dailyCapStoreSuite, T0 } from "../stores/daily-cap-suite";

dailyCapStoreSuite("memory", async () => new MemoryDailyCapStore());
dailyCapBulkSuite("memory", async () => new MemoryDailyCapStore());

describe("daily cap math", () => {
  it("puts a time in its 5-minute bucket", () => {
    expect(bucketStartOf(T0)).toBe(T0);
    expect(bucketStartOf(T0 + DAILY_CAP_BUCKET_MS - 1)).toBe(T0);
    expect(bucketStartOf(T0 + DAILY_CAP_BUCKET_MS)).toBe(T0 + DAILY_CAP_BUCKET_MS);
  });

  it("counts a bucket while any part of it is less than 24 hours old", () => {
    const expiry = bucketExpiry(T0);
    expect(T0 > windowFloor(expiry - 1)).toBe(true);
    expect(T0 > windowFloor(expiry)).toBe(false);
  });

  it("refuses a cap that is not a positive integer", () => {
    for (const cap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => checkDailyCap(cap, "test")).toThrow(RangeError);
    }
    expect(checkDailyCap(100, "test")).toBe(100);
  });
});
