// The rolling daily cap math. Each `DailyCapStore` keeps units in 5-minute buckets. A
// bucket counts while any part of it is less than 24 hours old, so the counter never
// lets more than `cap` units through in any 24-hour span.

import type { NotSentResult } from "./types";

/** The size of one bucket: 5 minutes. */
export const DAILY_CAP_BUCKET_MS: number = 5 * 60 * 1000;
/** The length of the window: 24 hours. */
export const DAILY_CAP_WINDOW_MS: number = 24 * 60 * 60 * 1000;

/** The start of the bucket that holds `now`, in Unix milliseconds. */
export function bucketStartOf(now: number): number {
  return Math.floor(now / DAILY_CAP_BUCKET_MS) * DAILY_CAP_BUCKET_MS;
}

/**
 * The window bound: a bucket counts when its start is greater than this value. The
 * bucket then ends less than 24 hours before `now`.
 */
export function windowFloor(now: number): number {
  return now - DAILY_CAP_WINDOW_MS - DAILY_CAP_BUCKET_MS;
}

/** When a bucket leaves the window, in Unix milliseconds. */
export function bucketExpiry(bucketStart: number): number {
  return bucketStart + DAILY_CAP_BUCKET_MS + DAILY_CAP_WINDOW_MS;
}

/**
 * Checks a daily cap option.
 *
 * @throws RangeError when the cap is not a positive safe integer.
 */
export function checkDailyCap(cap: number, label: string): number {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new RangeError(`${label}: dailyCap must be a positive integer.`);
  }
  return cap;
}

/**
 * Checks the `count` of a `reserveMany` call.
 *
 * @throws RangeError when the count is not a non-negative safe integer.
 */
export function checkReserveCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("reserveMany: count must be a non-negative integer.");
  }
  return count;
}

/** The result of a send that the daily cap refused. */
export function capRefusal(provider: string, resetAt: number): NotSentResult {
  return {
    status: "not_sent",
    reason: "daily_cap",
    message: "The daily cap of the provider is reached.",
    resetAt,
    provider,
  };
}
