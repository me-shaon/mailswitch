// In-memory stores for tests and single-isolate use. The data lives in one isolate only,
// so do not use these stores in production: a second isolate does not see the claims.

import { bucketExpiry, bucketStartOf, windowFloor } from "../core/daily-cap";
import { type TokenBucket, takeToken } from "../core/rate-limit";
import type {
  DailyCapFillInput,
  DailyCapReleaseInput,
  DailyCapReservation,
  DailyCapReserveInput,
  DailyCapStore,
  DedupeClaimInput,
  DedupeClaimOutcome,
  DedupeCommitInput,
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
  DailyCapStore,
  DedupeClaimInput,
  DedupeClaimOutcome,
  DedupeCommitInput,
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
    const record = this.#fenced(input.key, input.claimId);
    if (!record) return false;
    if (input.attempt) record.attempts.push({ ...input.attempt });
    record.updatedAt = input.now;
    return true;
  }

  async finish(input: IdempotencyFinishInput): Promise<boolean> {
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
    const buckets = this.#buckets(input.scope, input.now);
    const used = buckets.get(input.bucketStart) ?? 0;
    if (used > 1) buckets.set(input.bucketStart, used - 1);
    else buckets.delete(input.bucketStart);
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
    const current = this.#keys.get(input.key);
    if (current && current.expiresAt > input.now) {
      return { status: current.committed ? "duplicate" : "in_flight" };
    }
    const leaseId = crypto.randomUUID();
    this.#keys.set(input.key, { committed: false, expiresAt: input.now + input.leaseMs, leaseId });
    return { status: "new", leaseId };
  }

  async commit(input: DedupeCommitInput): Promise<boolean> {
    const current = this.#keys.get(input.key);
    if (current && current.leaseId !== input.leaseId) return false;
    this.#keys.set(input.key, {
      committed: true,
      expiresAt: input.now + input.ttlMs,
      leaseId: input.leaseId,
    });
    return true;
  }

  async release(input: DedupeReleaseInput): Promise<void> {
    const current = this.#keys.get(input.key);
    if (current?.committed === false && current.leaseId === input.leaseId) {
      this.#keys.delete(input.key);
    }
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
