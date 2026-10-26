// Store interfaces. Each concern has its own interface, so a store implements only what it
// supports.

import type { RateLimitGrant } from "../core/rate-limit";
import type { DeliveryStatus, FailureReason } from "../core/types";

export type { RateLimitGrant } from "../core/rate-limit";

/**
 * The state of one idempotency record.
 * - `pending`: a send holds the claim now.
 * - `sent`: an attempt was sent. A repeat returns the stored result.
 * - `not_sent`: every attempt was `not_sent`. The key is free again.
 * - `unknown`: an attempt was `unknown`, or the claim went stale. Only `release` frees the key.
 */
export type IdempotencyState = "pending" | "sent" | "not_sent" | "unknown";

/** A state that ends a claim. */
export type IdempotencyFinalState = Exclude<IdempotencyState, "pending">;

/** One provider attempt inside a claim. It holds no recipient, subject, or response body. */
export interface IdempotencyAttempt {
  /** The provider id. */
  provider: string;
  status: DeliveryStatus;
  reason?: FailureReason;
  /** When the attempt ended, in Unix milliseconds. */
  at: number;
}

/** One stored record. A record holds no PII. */
export interface IdempotencyRecord {
  /** The namespaced key, `${namespace}:${idempotencyKey}`. */
  key: string;
  /** The SHA-256 hex of the canonical message payload. */
  payloadHash: string;
  state: IdempotencyState;
  /** The random fencing token of the claim that wrote this record. */
  claimId: string;
  attempts: IdempotencyAttempt[];
  providerMessageId?: string;
  /** Unix milliseconds. */
  claimedAt: number;
  /** Unix milliseconds. */
  updatedAt: number;
  /** Set only for `sent` and `not_sent`. `purgeExpired` deletes the record after this time. */
  expiresAt?: number;
}

/** The input of `IdempotencyStore.claim`. */
export interface IdempotencyClaimInput {
  key: string;
  payloadHash: string;
  /** A random fencing token. Later writes for this claim must give the same value. */
  claimId: string;
  /** Unix milliseconds. */
  now: number;
  /** A `pending` record older than this is stale. */
  pendingTimeoutMs: number;
}

/**
 * The outcome of `IdempotencyStore.claim`. The store checks the cases in this order:
 *
 * 1. No record, a `not_sent` record, or an expired `sent` record: the store writes a new
 *    `pending` record and returns `claimed`.
 * 2. A `pending` record older than the timeout: the store changes it to `unknown`. This is
 *    a conditional update, so only one reader converts it.
 * 3. A record with a different payload hash: `conflict`.
 * 4. A record that this call converted in step 2: `stale`.
 * 5. A `pending` record: `pending`.
 * 6. A `sent` or `unknown` record: `existing`.
 */
export type IdempotencyClaimOutcome =
  | { kind: "claimed" }
  | { kind: "existing"; record: IdempotencyRecord }
  | { kind: "pending"; record: IdempotencyRecord }
  | { kind: "stale"; record: IdempotencyRecord }
  | { kind: "conflict"; record: IdempotencyRecord };

/** The input of `IdempotencyStore.appendAttempt`. */
export interface IdempotencyAppendInput {
  key: string;
  claimId: string;
  attempt: IdempotencyAttempt;
  now: number;
}

/** The input of `IdempotencyStore.finish`. */
export interface IdempotencyFinishInput {
  key: string;
  claimId: string;
  state: IdempotencyFinalState;
  /** The full attempt list. It replaces the stored list. */
  attempts: readonly IdempotencyAttempt[];
  providerMessageId?: string;
  now: number;
  /** Give it for `sent` and `not_sent` only. */
  expiresAt?: number;
}

/**
 * Stores one record per idempotency key. The record covers the whole provider chain.
 *
 * Every write after the claim is fenced: it applies only when the record has the same
 * `claimId` and the state is `pending`. A write that does not apply returns false and
 * changes nothing.
 *
 * Implementations must make `claim` atomic. An eventually consistent store, such as KV,
 * is not safe.
 */
export interface IdempotencyStore {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimOutcome>;
  /** Adds one attempt to a `pending` record. */
  appendAttempt(input: IdempotencyAppendInput): Promise<boolean>;
  /** Writes the final state of a `pending` record. */
  finish(input: IdempotencyFinishInput): Promise<boolean>;
  /**
   * Frees a key in the expected state. Only `unknown` can be released. Confirm with the
   * provider that the email did not go out before a release.
   */
  release(key: string, options: { expectedState: "unknown" }): Promise<boolean>;
  /** Reads a record. For operators and tests. It never changes the record. */
  get(key: string): Promise<IdempotencyRecord | null>;
  /**
   * Deletes `sent` and `not_sent` records with `expiresAt` before `now`. It never deletes
   * `pending` or `unknown` records. Returns the number of deleted records.
   */
  purgeExpired(now: number): Promise<number>;
}

/** The input of `DailyCapStore.reserve`. */
export interface DailyCapReserveInput {
  /** The cap scope, usually the provider id. One scope is one counter. */
  scope: string;
  /** The most units in the rolling 24-hour window. A positive integer. */
  cap: number;
  /** Unix milliseconds. */
  now: number;
}

/**
 * The outcome of `DailyCapStore.reserve`.
 * - `ok: true`: one unit is reserved in the 5-minute bucket that starts at `bucketStart`.
 *   Give `bucketStart` to `release` to refund the unit.
 * - `ok: false`: the window is full. `resetAt` is when the oldest bucket in the window
 *   leaves it, in Unix milliseconds.
 */
export type DailyCapReservation =
  | { ok: true; bucketStart: number }
  | { ok: false; resetAt: number };

/** The input of `DailyCapStore.release`. */
export interface DailyCapReleaseInput {
  scope: string;
  /** The `bucketStart` of the reservation. */
  bucketStart: number;
  /** Unix milliseconds. */
  now: number;
}

/** The input of `DailyCapStore.fill`. */
export interface DailyCapFillInput {
  scope: string;
  cap: number;
  /** Unix milliseconds. */
  now: number;
}

/**
 * Counts sends per scope in a rolling 24-hour window of 5-minute buckets. A bucket counts
 * while any part of it is less than 24 hours old.
 *
 * Implementations must make `reserve` atomic: two parallel calls cannot both take the
 * last unit. A read followed by a write is not safe.
 */
export interface DailyCapStore {
  /** Reserves one unit when the window has room. */
  reserve(input: DailyCapReserveInput): Promise<DailyCapReservation>;
  /** Refunds one unit from the bucket of a reservation. A bucket never goes below zero. */
  release(input: DailyCapReleaseInput): Promise<void>;
  /** Adds units to the current bucket until the window holds `cap` units. */
  fill(input: DailyCapFillInput): Promise<void>;
  /** The units in the window now. For operators and tests. */
  used(scope: string, now: number): Promise<number>;
}

/** The input of `RateLimitStore.acquire`. */
export interface RateLimitAcquireInput {
  /** The rate limit scope, usually the provider id. One scope is one token bucket. */
  scope: string;
  /** The refill rate, in tokens per second. A positive number. */
  ratePerSecond: number;
  /** The most tokens the bucket holds. At least 1. */
  burst: number;
  /** Unix milliseconds. */
  now: number;
}

/**
 * Keeps one token bucket per scope. Each send attempt takes one token.
 *
 * Implementations must make `acquire` atomic: two parallel calls cannot both take the
 * last token.
 */
export interface RateLimitStore {
  /** Takes one token when the bucket has one. A refusal takes nothing. */
  acquire(input: RateLimitAcquireInput): Promise<RateLimitGrant>;
}

/**
 * The outcome of `DedupeStore.claim`.
 * - `new`: this call holds the lease now. Commit the key after the event is handled.
 * - `duplicate`: the key was committed before and its TTL has not passed.
 * - `in_flight`: another request holds a lease on the key that has not expired.
 */
export type DedupeClaimOutcome = "new" | "duplicate" | "in_flight";

/** The input of `DedupeStore.claim`. */
export interface DedupeClaimInput {
  /** The dedupe key, `${provider}:${endpointId}:${eventKey}`. */
  key: string;
  /** How long the lease holds the key without a commit, in milliseconds. */
  leaseMs: number;
  /** Unix milliseconds. */
  now: number;
}

/** The input of `DedupeStore.commit`. */
export interface DedupeCommitInput {
  key: string;
  /** How long the committed key blocks a replay, in milliseconds. */
  ttlMs: number;
  /** Unix milliseconds. */
  now: number;
}

/** The input of `DedupeStore.release`. */
export interface DedupeReleaseInput {
  key: string;
}

/**
 * Stores webhook event keys in two phases: a claim with a lease, then a commit with a
 * TTL. A lease that expires without a commit frees the key, so a provider retry delivers
 * the event again. A committed key is a duplicate until its TTL passes.
 *
 * Implementations must make `claim` atomic: two parallel claims cannot both get `new`.
 */
export interface DedupeStore {
  /** Takes a lease on a free key, a key whose lease expired, or a key whose TTL passed. */
  claim(input: DedupeClaimInput): Promise<DedupeClaimOutcome>;
  /** Marks the key as handled. A later claim gets `duplicate` until the TTL passes. */
  commit(input: DedupeCommitInput): Promise<void>;
  /** Frees a key that is not committed. It never frees a committed key. */
  release(input: DedupeReleaseInput): Promise<void>;
  /**
   * Deletes committed keys whose TTL passed and leases that expired. Both are free for a
   * new claim already. Returns the number of deleted keys.
   */
  purgeExpired(now: number): Promise<number>;
}
