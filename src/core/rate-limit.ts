// The token bucket math of the per-provider rate limit. Each `RateLimitStore` keeps one
// bucket per scope. The bucket holds up to `burst` tokens and refills at `ratePerSecond`.
// One send attempt takes one token. A bucket with less than one token refuses the attempt
// and tells the caller when the next token is ready. A refusal takes nothing.

/** The stored state of one token bucket. */
export interface TokenBucket {
  /** The tokens at `updatedAt`. From 0 to the burst. */
  tokens: number;
  /** Unix milliseconds. */
  updatedAt: number;
}

/**
 * The outcome of a token request.
 * - `ok: true`: the attempt took one token.
 * - `ok: false`: the bucket is empty. `retryAfterMs` is the wait for the next token.
 */
export type RateLimitGrant = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Takes one token from a bucket. A missing bucket starts full. The function does not
 * change its input. It returns the new bucket state to store.
 */
export function takeToken(
  bucket: TokenBucket | undefined,
  ratePerSecond: number,
  burst: number,
  now: number,
): { bucket: TokenBucket; grant: RateLimitGrant } {
  const start = bucket ?? { tokens: burst, updatedAt: now };
  const elapsed = Math.max(0, now - start.updatedAt);
  const tokens = Math.min(burst, start.tokens + (elapsed / 1000) * ratePerSecond);
  if (tokens >= 1) {
    return { bucket: { tokens: tokens - 1, updatedAt: now }, grant: { ok: true } };
  }
  const retryAfterMs = Math.max(1, Math.ceil(((1 - tokens) / ratePerSecond) * 1000));
  return { bucket: { tokens, updatedAt: now }, grant: { ok: false, retryAfterMs } };
}

/** A checked rate limit option. */
export interface RateRule {
  perSecond: number;
  burst: number;
}

/**
 * Checks a rate limit option. The burst defaults to the rate, and is at least 1.
 *
 * @throws RangeError when the rate is not a positive finite number, or the burst is
 * below 1.
 */
export function checkRate(rate: { perSecond: number; burst?: number }, label: string): RateRule {
  const perSecond = rate?.perSecond;
  if (typeof perSecond !== "number" || !Number.isFinite(perSecond) || perSecond <= 0) {
    throw new RangeError(`${label}: rate.perSecond must be a positive number.`);
  }
  const burst = rate.burst ?? Math.max(1, perSecond);
  if (typeof burst !== "number" || !Number.isFinite(burst) || burst < 1) {
    throw new RangeError(`${label}: rate.burst must be a number of at least 1.`);
  }
  return { perSecond, burst };
}
