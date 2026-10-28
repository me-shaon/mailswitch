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
  /**
   * The last write, in Unix milliseconds. A `touch` renews it. The stale check of `claim`
   * measures from this time.
   */
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
  /** A `pending` record whose `updatedAt` is older than this is stale. */
  pendingTimeoutMs: number;
}

/**
 * The outcome of `IdempotencyStore.claim`. The store checks the cases in this order:
 *
 * 1. No record, a `not_sent` record, or an expired `sent` record: the store writes a new
 *    `pending` record and returns `claimed`.
 * 2. A `pending` record whose last write (`updatedAt`) is older than the timeout: the
 *    store changes it to `unknown`. This is a conditional update, so only one reader
 *    converts it.
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

/** The input of `IdempotencyStore.touch`. */
export interface IdempotencyTouchInput {
  key: string;
  claimId: string;
  /** Unix milliseconds. The new `updatedAt`. */
  now: number;
  /** An attempt that ended since the last write. The store appends it to the list. */
  attempt?: IdempotencyAttempt;
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
 *
 * The bulk methods `claimMany`, `touchMany`, and `finishMany` are optional. `sendBatch`
 * uses them only when a store has all three, and only when each bulk method comes from
 * the same object in the prototype chain as the single method that it replaces. Each
 * bulk method must give the same results as its single method in a loop.
 *
 * Rules for each bulk method:
 * - It returns one result for each input, in input order.
 * - The call is atomic: it applies all inputs or no input.
 * - A throw does not prove that no input was applied. The call can commit and then lose
 *   its response. The caller treats a throw as a failure of every input in the call and
 *   does not retry the call.
 * - Callers give at most 100 inputs in one call.
 */
export interface IdempotencyStore {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimOutcome>;
  /**
   * The heartbeat of a claim. The pipeline calls it before each provider call. It sets
   * `updatedAt` to `now` and appends `attempt` when given. It applies only where the claim
   * ID matches and the state is `pending`. False means that the claim is lost: do not
   * call the provider.
   */
  touch(input: IdempotencyTouchInput): Promise<boolean>;
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
  /**
   * Claims each key as `claim` does. Returns one outcome for each input, in input order.
   * It throws a TypeError for a repeated key and then claims no key.
   */
  claimMany?(inputs: readonly IdempotencyClaimInput[]): Promise<IdempotencyClaimOutcome[]>;
  /**
   * Touches each claim as `touch` does. Returns one result for each input, in input
   * order. False means that the claim of that input is lost.
   */
  touchMany?(inputs: readonly IdempotencyTouchInput[]): Promise<boolean[]>;
  /**
   * Writes each final state as `finish` does. Returns one result for each input, in input
   * order. False means that the write of that input did not apply.
   */
  finishMany?(inputs: readonly IdempotencyFinishInput[]): Promise<boolean[]>;
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

/** The input of `DailyCapStore.reserveMany`. */
export interface DailyCapReserveManyInput {
  /** The cap scope, usually the provider id. One scope is one counter. */
  scope: string;
  /** The most units in the rolling 24-hour window. A positive integer. */
  cap: number;
  /** The number of units to reserve. A non-negative integer. */
  count: number;
  /** Unix milliseconds. */
  now: number;
}

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
 *
 * The bulk methods `reserveMany` and `releaseMany` are optional. `sendBatch` uses them
 * only when a store has both, and only when each bulk method comes from the same object
 * in the prototype chain as the single method that it replaces. Each bulk method must
 * give the same results as its single method in a loop.
 *
 * Rules for each bulk method:
 * - The call is atomic: it applies all units or no unit.
 * - A throw does not prove that no unit was applied. The call can commit and then lose
 *   its response. The caller treats a throw as a failure of every unit in the call and
 *   does not retry the call.
 * - Callers give at most 100 units or inputs in one call.
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
  /**
   * Reserves `count` units as `reserve` does in a loop. Returns one reservation for each
   * unit, in order. When the window has room for only k units, the first k reservations
   * are granted and the others are refused with the reset time. All granted units are
   * in one bucket.
   */
  reserveMany?(input: DailyCapReserveManyInput): Promise<DailyCapReservation[]>;
  /** Refunds each input as `release` does, in input order. */
  releaseMany?(inputs: readonly DailyCapReleaseInput[]): Promise<void>;
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
 * - `new`: this call holds the lease now. Commit the key with `leaseId` after the event is
 *   handled, or release it with `leaseId`.
 * - `duplicate`: the key was committed before and its TTL has not passed.
 * - `in_flight`: another request holds a lease on the key that has not expired.
 */
export type DedupeClaimOutcome =
  | { status: "new"; leaseId: string }
  | { status: "duplicate" }
  | { status: "in_flight" };

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
  /** The lease id that `claim` returned with `new`. */
  leaseId: string;
  /** How long the committed key blocks a replay, in milliseconds. */
  ttlMs: number;
  /** Unix milliseconds. */
  now: number;
}

/** The input of `DedupeStore.release`. */
export interface DedupeReleaseInput {
  key: string;
  /** The lease id that `claim` returned with `new`. */
  leaseId: string;
}

/** The input of `DedupeStore.claimMany`. */
export interface DedupeClaimManyInput {
  /** The dedupe keys. Each key must be distinct. */
  keys: readonly string[];
  /** How long each lease holds its key without a commit, in milliseconds. */
  leaseMs: number;
  /** Unix milliseconds. */
  now: number;
}

/** The input of `DedupeStore.commitMany`. */
export interface DedupeCommitManyInput {
  /** The leases to commit. Each lease is a key and the lease id that a claim returned. */
  leases: readonly DedupeReleaseInput[];
  /** How long each committed key blocks a replay, in milliseconds. */
  ttlMs: number;
  /** Unix milliseconds. */
  now: number;
}

/**
 * Stores webhook event keys in two phases: a claim with a lease, then a commit with a
 * TTL. A lease that expires without a commit frees the key, so a provider retry delivers
 * the event again. A committed key is a duplicate until its TTL passes.
 *
 * Each lease has a random id. `commit` and `release` act only on the lease with that id.
 * When a lease expires and a newer request claims the key, the old holder can no longer
 * release or commit the key. The newer holder owns it.
 *
 * Implementations must make `claim` atomic: two parallel claims cannot both get `new`.
 *
 * The bulk methods `claimMany`, `commitMany`, and `releaseMany` are optional. The webhook
 * router uses them only when a store has all three. Each bulk method must give the same
 * result as its single method in a loop.
 */
export interface DedupeStore {
  /** Takes a lease on a free key, a key whose lease expired, or a key whose TTL passed. */
  claim(input: DedupeClaimInput): Promise<DedupeClaimOutcome>;
  /**
   * Marks the key as handled. A later claim gets `duplicate` until the TTL passes.
   * The commit applies when the row holds this lease id (expired or not, committed or
   * not) or when no row exists. When another lease holds the key, the commit does
   * nothing and returns `false`, because the newer holder commits or releases it.
   */
  commit(input: DedupeCommitInput): Promise<boolean>;
  /**
   * Frees the key when it is not committed and this lease id still holds it. It never
   * frees a committed key or a key that another lease holds.
   */
  release(input: DedupeReleaseInput): Promise<void>;
  /**
   * Claims each key as `claim` does. Returns one outcome for each key, in input order.
   * The call is atomic: when it throws, it claimed no key. It throws a TypeError for a
   * repeated key.
   */
  claimMany?(input: DedupeClaimManyInput): Promise<DedupeClaimOutcome[]>;
  /**
   * Commits each lease as `commit` does. Returns one result for each lease, in input
   * order. The call is atomic: when it throws, it committed no lease.
   */
  commitMany?(input: DedupeCommitManyInput): Promise<boolean[]>;
  /** Releases each lease as `release` does. */
  releaseMany?(leases: readonly DedupeReleaseInput[]): Promise<void>;
  /**
   * Deletes committed keys whose TTL passed and leases that expired. Both are free for a
   * new claim already. Returns the number of deleted keys.
   */
  purgeExpired(now: number): Promise<number>;
}
