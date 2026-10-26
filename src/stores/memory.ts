// In-memory stores for tests and single-isolate use. The data lives in one isolate only,
// so do not use these stores in production: a second isolate does not see the claims.

import type {
  IdempotencyAppendInput,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyStore,
} from "./types";

export type {
  IdempotencyAppendInput,
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinalState,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyState,
  IdempotencyStore,
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
    if (current.state === "pending" && current.claimedAt < now - pendingTimeoutMs) {
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

  async appendAttempt(input: IdempotencyAppendInput): Promise<boolean> {
    const record = this.#fenced(input.key, input.claimId);
    if (!record) return false;
    record.attempts.push({ ...input.attempt });
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
