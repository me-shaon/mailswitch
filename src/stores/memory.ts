// In-memory stores for tests and single-isolate use. The data lives in one isolate only,
// so do not use these stores in production: a second isolate does not see the claims.

import { bucketExpiry, bucketStartOf, checkReserveCount, windowFloor } from "../core/daily-cap";
import { type TokenBucket, takeToken } from "../core/rate-limit";
import { assertDistinctKeys } from "../internal/distinct-keys";
import type {
  DailyCapFillInput,
  DailyCapReleaseInput,
  DailyCapReservation,
  DailyCapReserveInput,
  DailyCapReserveManyInput,
  DailyCapStore,
  DedupeClaimInput,
  DedupeClaimManyInput,
  DedupeClaimOutcome,
  DedupeCommitInput,
  DedupeCommitManyInput,
  DedupeReleaseInput,
  DedupeStore,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyStore,
  IdempotencyTouchInput,
  RateLimitAcquireInput,
  RateLimitGrant,
  RateLimitStore,
} from "./types";

export type {
  DailyCapFillInput,
  DailyCapReleaseInput,
  DailyCapReservation,
  DailyCapReserveInput,
  DailyCapReserveManyInput,
  DailyCapStore,
  DedupeClaimInput,
  DedupeClaimManyInput,
  DedupeClaimOutcome,
  DedupeCommitInput,
  DedupeCommitManyInput,
  DedupeReleaseInput,
  DedupeStore,
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinalState,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyState,
  IdempotencyStore,
  IdempotencyTouchInput,
  RateLimitAcquireInput,
  RateLimitGrant,
  RateLimitStore,
} from "./types";

function copy(record: IdempotencyRecord): IdempotencyRecord {
  return { ...record, attempts: record.attempts.map((attempt) => ({ ...attempt })) };
}

/**
 * An `IdempotencyStore` in a `Map`. Each method runs to completion before it yields, so
 * the claim is atomic inside one isolate.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimOutcome> {
    return this.#claim(input);
  }

  #claim(input: IdempotencyClaimInput): IdempotencyClaimOutcome {
    const { key, payloadHash, claimId, now, pendingTimeoutMs } = input;
    const current = this.#records.get(key);
    const free =
      !current ||
      current.state === "not_sent" ||
      (current.state === "sent" && current.expiresAt !== undefined && current.expiresAt < now);
    if (free) {
      this.#records.set(key, {
        key,
        payloadHash,
        state: "pending",
        claimId,
        attempts: [],
        claimedAt: now,
        updatedAt: now,
      });
      return { kind: "claimed" };
    }
    let converted = false;
    if (current.state === "pending" && current.updatedAt < now - pendingTimeoutMs) {
      current.state = "unknown";
      current.updatedAt = now;
      converted = true;
    }
    const record = copy(current);
    if (current.payloadHash !== payloadHash) return { kind: "conflict", record };
    if (converted) return { kind: "stale", record };
    if (current.state === "pending") return { kind: "pending", record };
    return { kind: "existing", record };
  }

  #fenced(key: string, claimId: string): IdempotencyRecord | undefined {
    const record = this.#records.get(key);
    return record && record.claimId === claimId && record.state === "pending" ? record : undefined;
  }

  async touch(input: IdempotencyTouchInput): Promise<boolean> {
    return this.#touch(input);
  }

  #touch(input: IdempotencyTouchInput): boolean {
    const record = this.#fenced(input.key, input.claimId);
    if (!record) return false;
    if (input.attempt) record.attempts.push({ ...input.attempt });
    record.updatedAt = input.now;
    return true;
  }

  async finish(input: IdempotencyFinishInput): Promise<boolean> {
    return this.#finish(input);
  }

  #finish(input: IdempotencyFinishInput): boolean {
    const record = this.#fenced(input.key, input.claimId);
    if (!record) return false;
    record.state = input.state;
    record.attempts = input.attempts.map((attempt) => ({ ...attempt }));
    record.updatedAt = input.now;
    if (input.providerMessageId !== undefined) record.providerMessageId = input.providerMessageId;
    // Only `sent` and `not_sent` records expire. An `unknown` record stays until a release.
    if (input.state !== "unknown" && input.expiresAt !== undefined) {
      record.expiresAt = input.expiresAt;
    }
    return true;
  }

  /** Claims each key in one synchronous pass, so the call is atomic inside one isolate. */
  async claimMany(inputs: readonly IdempotencyClaimInput[]): Promise<IdempotencyClaimOutcome[]> {
    assertDistinctKeys(inputs.map((input) => input.key));
    return inputs.map((input) => this.#claim(input));
  }

  /** Touches each claim in one synchronous pass. */
  async touchMany(inputs: readonly IdempotencyTouchInput[]): Promise<boolean[]> {
    return inputs.map((input) => this.#touch(input));
  }

  /** Writes each final state in one synchronous pass. */
  async finishMany(inputs: readonly IdempotencyFinishInput[]): Promise<boolean[]> {
    return inputs.map((input) => this.#finish(input));
  }

  async release(key: string, options: { expectedState: "unknown" }): Promise<boolean> {
    if (options?.expectedState !== "unknown") {
      throw new TypeError("release only frees a key in the unknown state.");
    }
    const record = this.#records.get(key);
    if (record?.state !== "unknown") return false;
    this.#records.delete(key);
    return true;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const record = this.#records.get(key);
    return record ? copy(record) : null;
  }

  async purgeExpired(now: number): Promise<number> {
    let deleted = 0;
    for (const [key, record] of this.#records) {
      if (
        (record.state === "sent" || record.state === "not_sent") &&
        record.expiresAt !== undefined &&
        record.expiresAt < now
      ) {
        this.#records.delete(key);
        deleted++;
      }
    }
    return deleted;
  }
}

/**
 * A `DailyCapStore` in a `Map` of buckets per scope. Each method runs to completion before
 * it yields, so `reserve` is atomic inside one isolate.
 */
export class MemoryDailyCapStore implements DailyCapStore {
  readonly #scopes = new Map<string, Map<number, number>>();

  /** The buckets of a scope that are still in the window. It drops the others. */
  #buckets(scope: string, now: number): Map<number, number> {
    let buckets = this.#scopes.get(scope);
    if (!buckets) {
      buckets = new Map();
      this.#scopes.set(scope, buckets);
    }
    const floor = windowFloor(now);
    for (const [start, used] of buckets) {
      if (start <= floor || used <= 0) buckets.delete(start);
    }
    return buckets;
  }

  #sum(buckets: Map<number, number>): number {
    let used = 0;
    for (const value of buckets.values()) used += value;
    return used;
  }

  async reserve(input: DailyCapReserveInput): Promise<DailyCapReservation> {
    return this.#reserve(input);
  }

  #reserve(input: DailyCapReserveInput): DailyCapReservation {
    const buckets = this.#buckets(input.scope, input.now);
    if (this.#sum(buckets) >= input.cap) {
      const oldest = Math.min(...buckets.keys());
      return { ok: false, resetAt: bucketExpiry(oldest) };
    }
    const start = bucketStartOf(input.now);
    buckets.set(start, (buckets.get(start) ?? 0) + 1);
    return { ok: true, bucketStart: start };
  }

  async release(input: DailyCapReleaseInput): Promise<void> {
    this.#release(input);
  }

  #release(input: DailyCapReleaseInput): void {
    const buckets = this.#buckets(input.scope, input.now);
    const used = buckets.get(input.bucketStart) ?? 0;
    if (used > 1) buckets.set(input.bucketStart, used - 1);
    else buckets.delete(input.bucketStart);
  }

  /**
   * Reserves each unit in one synchronous pass, so the call is atomic inside one isolate.
   * The first units get the room that is left. The others are refused.
   */
  async reserveMany(input: DailyCapReserveManyInput): Promise<DailyCapReservation[]> {
    const count = checkReserveCount(input.count);
    const single = { scope: input.scope, cap: input.cap, now: input.now };
    return Array.from({ length: count }, () => this.#reserve(single));
  }

  /** Refunds each input in one synchronous pass. */
  async releaseMany(inputs: readonly DailyCapReleaseInput[]): Promise<void> {
    for (const input of inputs) this.#release(input);
  }

  async fill(input: DailyCapFillInput): Promise<void> {
    const buckets = this.#buckets(input.scope, input.now);
    const missing = input.cap - this.#sum(buckets);
    if (missing <= 0) return;
    const start = bucketStartOf(input.now);
    buckets.set(start, (buckets.get(start) ?? 0) + missing);
  }

  async used(scope: string, now: number): Promise<number> {
    return this.#sum(this.#buckets(scope, now));
  }
}

/**
 * A `DedupeStore` in a `Map`. Each method runs to completion before it yields, so the
 * claim is atomic inside one isolate.
 */
export class MemoryDedupeStore implements DedupeStore {
  readonly #keys = new Map<string, { committed: boolean; expiresAt: number; leaseId: string }>();

  async claim(input: DedupeClaimInput): Promise<DedupeClaimOutcome> {
    return this.#claim(input.key, input.leaseMs, input.now);
  }

  async commit(input: DedupeCommitInput): Promise<boolean> {
    return this.#commit(input.key, input.leaseId, input.ttlMs, input.now);
  }

  async release(input: DedupeReleaseInput): Promise<void> {
    this.#release(input.key, input.leaseId);
  }

  #claim(key: string, leaseMs: number, now: number): DedupeClaimOutcome {
    const current = this.#keys.get(key);
    if (current && current.expiresAt > now) {
      return { status: current.committed ? "duplicate" : "in_flight" };
    }
    const leaseId = crypto.randomUUID();
    this.#keys.set(key, { committed: false, expiresAt: now + leaseMs, leaseId });
    return { status: "new", leaseId };
  }

  #commit(key: string, leaseId: string, ttlMs: number, now: number): boolean {
    const current = this.#keys.get(key);
    if (current && current.leaseId !== leaseId) return false;
    this.#keys.set(key, { committed: true, expiresAt: now + ttlMs, leaseId });
    return true;
  }

  #release(key: string, leaseId: string): void {
    const current = this.#keys.get(key);
    if (current?.committed === false && current.leaseId === leaseId) this.#keys.delete(key);
  }

  /** Claims each key in one synchronous pass, so the call is atomic inside one isolate. */
  async claimMany(input: DedupeClaimManyInput): Promise<DedupeClaimOutcome[]> {
    assertDistinctKeys(input.keys);
    return input.keys.map((key) => this.#claim(key, input.leaseMs, input.now));
  }

  async commitMany(input: DedupeCommitManyInput): Promise<boolean[]> {
    return input.leases.map((lease) =>
      this.#commit(lease.key, lease.leaseId, input.ttlMs, input.now),
    );
  }

  async releaseMany(leases: readonly DedupeReleaseInput[]): Promise<void> {
    for (const lease of leases) this.#release(lease.key, lease.leaseId);
  }

  async purgeExpired(now: number): Promise<number> {
    let deleted = 0;
    for (const [key, entry] of this.#keys) {
      if (entry.expiresAt <= now) {
        this.#keys.delete(key);
        deleted++;
      }
    }
    return deleted;
  }
}

/**
 * A `RateLimitStore` in a `Map` of token buckets per scope. Each call runs to completion
 * before it yields, so `acquire` is atomic inside one isolate.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, TokenBucket>();

  async acquire(input: RateLimitAcquireInput): Promise<RateLimitGrant> {
    const { bucket, grant } = takeToken(
      this.#buckets.get(input.scope),
      input.ratePerSecond,
      input.burst,
      input.now,
    );
    this.#buckets.set(input.scope, bucket);
    return grant;
  }
}
