// D1 stores. D1 has a single writer and runs a batch as one transaction, so a conditional
// write is atomic. This file uses a structural D1 type, so it imports no Workers module.

import { bucketExpiry, bucketStartOf, checkReserveCount, windowFloor } from "../core/daily-cap";
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
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyState,
  IdempotencyStore,
  IdempotencyTouchInput,
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
} from "./types";

/** The part of a D1 result that the stores read. */
export interface D1ResultLike<T = unknown> {
  results?: T[];
  meta: { changes?: number };
}

/** The part of a D1 prepared statement that the stores use. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<D1ResultLike>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

/** The part of a `D1Database` binding that the stores use. A real binding fits this type. */
export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
  batch<T = unknown>(statements: D1StatementLike[]): Promise<D1ResultLike<T>[]>;
}

/**
 * The schema of the mailswitch tables: the idempotency table, the daily cap buckets, and
 * the webhook dedupe keys.
 * Apply it with `applyD1Schema`, or copy it into a migration. The package export
 * `mailswitch/stores/d1-schema.sql` holds the same text.
 */
export const D1_SCHEMA = `CREATE TABLE IF NOT EXISTS mailswitch_idempotency (
  key TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'not_sent', 'unknown')),
  claim_id TEXT NOT NULL,
  attempts TEXT NOT NULL DEFAULT '[]',
  provider_message_id TEXT,
  claimed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS mailswitch_idempotency_expires_at ON mailswitch_idempotency (expires_at);
CREATE TABLE IF NOT EXISTS mailswitch_daily_cap (
  scope TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK (used >= 0),
  PRIMARY KEY (scope, bucket_start)
);
CREATE TABLE IF NOT EXISTS mailswitch_webhook_dedupe (
  key TEXT PRIMARY KEY NOT NULL,
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
  expires_at INTEGER NOT NULL,
  lease_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mailswitch_webhook_dedupe_expires_at ON mailswitch_webhook_dedupe (expires_at);
`;

/** Runs each statement of a schema in one batch. The statements use `IF NOT EXISTS`. */
export async function applyD1Schema(db: D1DatabaseLike, schema: string = D1_SCHEMA): Promise<void> {
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "")
    .map((statement) => db.prepare(statement));
  await db.batch(statements);
}

interface Row {
  key: string;
  payload_hash: string;
  state: IdempotencyState;
  claim_id: string;
  attempts: string;
  provider_message_id: string | null;
  claimed_at: number;
  updated_at: number;
  expires_at: number | null;
}

function toRecord(row: Row): IdempotencyRecord {
  const record: IdempotencyRecord = {
    key: row.key,
    payloadHash: row.payload_hash,
    state: row.state,
    claimId: row.claim_id,
    attempts: JSON.parse(row.attempts) as IdempotencyAttempt[],
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
  if (row.provider_message_id !== null) record.providerMessageId = row.provider_message_id;
  if (row.expires_at !== null) record.expiresAt = row.expires_at;
  return record;
}

function changes(result: D1ResultLike | undefined): number {
  return result?.meta.changes ?? 0;
}

const TABLE = "mailswitch_idempotency";
const FENCE = "key = ?1 AND claim_id = ?2 AND state = 'pending'";

/** An `IdempotencyStore` on a D1 database. Apply `D1_SCHEMA` first. */
export class D1IdempotencyStore implements IdempotencyStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new TypeError("D1IdempotencyStore needs a D1 database binding.");
    }
    this.#db = db;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimOutcome> {
    const [outcome] = await this.#claimAll([input]);
    if (!outcome) throw new Error("D1IdempotencyStore could not read the claimed row.");
    return outcome;
  }

  async touch(input: IdempotencyTouchInput): Promise<boolean> {
    return changes(await this.#touchStatement(input).run()) === 1;
  }

  async finish(input: IdempotencyFinishInput): Promise<boolean> {
    return changes(await this.#finishStatement(input).run()) === 1;
  }

  /**
   * Claims every key in one batch. D1 runs a batch as one transaction, so a failed
   * statement rolls back the claims of every key in the call.
   */
  async claimMany(inputs: readonly IdempotencyClaimInput[]): Promise<IdempotencyClaimOutcome[]> {
    assertDistinctKeys(inputs.map((input) => input.key));
    if (inputs.length === 0) return [];
    return this.#claimAll(inputs);
  }

  /** Touches every claim in one batch. A failed statement rolls back every touch. */
  async touchMany(inputs: readonly IdempotencyTouchInput[]): Promise<boolean[]> {
    if (inputs.length === 0) return [];
    const results = await this.#db.batch(inputs.map((input) => this.#touchStatement(input)));
    return inputs.map((_, i) => changes(results[i]) === 1);
  }

  /** Writes every final state in one batch. A failed statement rolls back every write. */
  async finishMany(inputs: readonly IdempotencyFinishInput[]): Promise<boolean[]> {
    if (inputs.length === 0) return [];
    const results = await this.#db.batch(inputs.map((input) => this.#finishStatement(input)));
    return inputs.map((_, i) => changes(results[i]) === 1);
  }

  // Each key has 4 statements in one batch, and one batch is one transaction: insert a new
  // claim, re-claim a free key, convert a stale claim, then read the row. Only one of the
  // three writes can apply for each key.
  async #claimAll(inputs: readonly IdempotencyClaimInput[]): Promise<IdempotencyClaimOutcome[]> {
    const db = this.#db;
    const statements = inputs.flatMap(({ key, payloadHash, claimId, now, pendingTimeoutMs }) => [
      db
        .prepare(
          `INSERT INTO ${TABLE} (key, payload_hash, state, claim_id, attempts, claimed_at, updated_at)
           VALUES (?1, ?2, 'pending', ?3, '[]', ?4, ?4)
           ON CONFLICT(key) DO NOTHING RETURNING key`,
        )
        .bind(key, payloadHash, claimId, now),
      db
        .prepare(
          `UPDATE ${TABLE} SET payload_hash = ?2, state = 'pending', claim_id = ?3, attempts = '[]',
             provider_message_id = NULL, claimed_at = ?4, updated_at = ?4, expires_at = NULL
           WHERE key = ?1 AND (state = 'not_sent'
             OR (state = 'sent' AND expires_at IS NOT NULL AND expires_at < ?4))`,
        )
        .bind(key, payloadHash, claimId, now),
      db
        .prepare(
          `UPDATE ${TABLE} SET state = 'unknown', updated_at = ?2
           WHERE key = ?1 AND state = 'pending' AND updated_at < ?3`,
        )
        .bind(key, now, now - pendingTimeoutMs),
      db.prepare(`SELECT * FROM ${TABLE} WHERE key = ?1`).bind(key),
    ]);
    const results = await db.batch<Row>(statements);
    return inputs.map(({ payloadHash, claimId }, i): IdempotencyClaimOutcome => {
      const row = results[i * 4 + 3]?.results?.[0];
      if (!row) throw new Error("D1IdempotencyStore could not read the claimed row.");
      const record = toRecord(row);
      if (record.claimId === claimId && record.state === "pending") return { kind: "claimed" };
      if (record.payloadHash !== payloadHash) return { kind: "conflict", record };
      if (changes(results[i * 4 + 2]) === 1) return { kind: "stale", record };
      if (record.state === "pending") return { kind: "pending", record };
      return { kind: "existing", record };
    });
  }

  // One conditional UPDATE: the heartbeat and the optional attempt apply together.
  #touchStatement(input: IdempotencyTouchInput): D1StatementLike {
    const attempt = input.attempt ? JSON.stringify(input.attempt) : null;
    return this.#db
      .prepare(
        `UPDATE ${TABLE} SET updated_at = ?4,
           attempts = CASE WHEN ?3 IS NULL THEN attempts ELSE json_insert(attempts, '$[#]', json(?3)) END
         WHERE ${FENCE}`,
      )
      .bind(input.key, input.claimId, attempt, input.now);
  }

  #finishStatement(input: IdempotencyFinishInput): D1StatementLike {
    // Only `sent` and `not_sent` records expire. An `unknown` record stays until a release.
    const expiresAt = input.state === "unknown" ? null : (input.expiresAt ?? null);
    return this.#db
      .prepare(
        `UPDATE ${TABLE} SET state = ?3, attempts = ?4,
           provider_message_id = COALESCE(?5, provider_message_id), updated_at = ?6, expires_at = ?7
         WHERE ${FENCE}`,
      )
      .bind(
        input.key,
        input.claimId,
        input.state,
        JSON.stringify(input.attempts),
        input.providerMessageId ?? null,
        input.now,
        expiresAt,
      );
  }

  async release(key: string, options: { expectedState: "unknown" }): Promise<boolean> {
    if (options?.expectedState !== "unknown") {
      throw new TypeError("release only frees a key in the unknown state.");
    }
    const result = await this.#db
      .prepare(`DELETE FROM ${TABLE} WHERE key = ?1 AND state = 'unknown'`)
      .bind(key)
      .run();
    return changes(result) === 1;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const row = await this.#db
      .prepare(`SELECT * FROM ${TABLE} WHERE key = ?1`)
      .bind(key)
      .first<Row>();
    return row ? toRecord(row) : null;
  }

  async purgeExpired(now: number): Promise<number> {
    const result = await this.#db
      .prepare(
        `DELETE FROM ${TABLE}
         WHERE expires_at IS NOT NULL AND expires_at < ?1 AND state IN ('sent', 'not_sent')`,
      )
      .bind(now)
      .run();
    return changes(result);
  }
}

const CAP_TABLE = "mailswitch_daily_cap";
const WINDOW_SUM = `SELECT COALESCE(SUM(used), 0) FROM ${CAP_TABLE} WHERE scope = ?1 AND bucket_start > ?3`;

/**
 * A `DailyCapStore` on a D1 database. Apply `D1_SCHEMA` first.
 *
 * `reserve` is one statement. It upserts the current bucket only when the sum of the
 * window is below the cap. SQLite runs one statement at a time, so two parallel calls
 * cannot both take the last unit.
 */
export class D1DailyCapStore implements DailyCapStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new TypeError("D1DailyCapStore needs a D1 database binding.");
    }
    this.#db = db;
  }

  async reserve(input: DailyCapReserveInput): Promise<DailyCapReservation> {
    const [reservation] = await this.#reserveAll(input, 1);
    if (!reservation) throw new Error("D1DailyCapStore could not read the reservation.");
    return reservation;
  }

  async release(input: DailyCapReleaseInput): Promise<void> {
    await this.#releaseStatement(input).run();
  }

  /**
   * Reserves `count` units in one batch. Each insert sees the earlier inserts of the same
   * transaction, so the grant stops at the cap. A failed statement rolls back every unit.
   */
  async reserveMany(input: DailyCapReserveManyInput): Promise<DailyCapReservation[]> {
    const count = checkReserveCount(input.count);
    if (count === 0) return [];
    return this.#reserveAll(input, count);
  }

  /** Refunds every input in one batch. */
  async releaseMany(inputs: readonly DailyCapReleaseInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.#db.batch(inputs.map((input) => this.#releaseStatement(input)));
  }

  // One batch is one transaction: delete old buckets once, reserve each unit, then read the
  // oldest bucket in the window once for the reset time. A reserve inserts no row when the
  // window is full, so the conflict update runs only when there is room.
  async #reserveAll(input: DailyCapReserveInput, count: number): Promise<DailyCapReservation[]> {
    const db = this.#db;
    const start = bucketStartOf(input.now);
    const floor = windowFloor(input.now);
    const reserve = (): D1StatementLike =>
      db
        .prepare(
          `INSERT INTO ${CAP_TABLE} (scope, bucket_start, used)
           SELECT ?1, ?2, 1 WHERE (${WINDOW_SUM}) < ?4
           ON CONFLICT(scope, bucket_start) DO UPDATE SET used = used + 1
           RETURNING used`,
        )
        .bind(input.scope, start, floor, input.cap);
    const results = await db.batch<{ used?: number; oldest?: number | null }>([
      db
        .prepare(`DELETE FROM ${CAP_TABLE} WHERE scope = ?1 AND bucket_start <= ?2`)
        .bind(input.scope, floor),
      ...Array.from({ length: count }, reserve),
      db
        .prepare(
          `SELECT MIN(bucket_start) AS oldest FROM ${CAP_TABLE}
           WHERE scope = ?1 AND bucket_start > ?2 AND used > 0`,
        )
        .bind(input.scope, floor),
    ]);
    const oldest = results[count + 1]?.results?.[0]?.oldest;
    const resetAt = bucketExpiry(typeof oldest === "number" ? oldest : start);
    return Array.from({ length: count }, (_, i): DailyCapReservation => {
      if ((results[i + 1]?.results?.length ?? 0) > 0) return { ok: true, bucketStart: start };
      return { ok: false, resetAt };
    });
  }

  #releaseStatement(input: DailyCapReleaseInput): D1StatementLike {
    return this.#db
      .prepare(
        `UPDATE ${CAP_TABLE} SET used = used - 1
         WHERE scope = ?1 AND bucket_start = ?2 AND used > 0`,
      )
      .bind(input.scope, input.bucketStart);
  }

  async fill(input: DailyCapFillInput): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO ${CAP_TABLE} (scope, bucket_start, used)
         SELECT ?1, ?2, ?4 - total FROM (SELECT (${WINDOW_SUM}) AS total) WHERE total < ?4
         ON CONFLICT(scope, bucket_start) DO UPDATE SET used = used + excluded.used`,
      )
      .bind(input.scope, bucketStartOf(input.now), windowFloor(input.now), input.cap)
      .run();
  }

  async used(scope: string, now: number): Promise<number> {
    const row = await this.#db
      .prepare(
        `SELECT COALESCE(SUM(used), 0) AS total FROM ${CAP_TABLE}
         WHERE scope = ?1 AND bucket_start > ?2`,
      )
      .bind(scope, windowFloor(now))
      .first<{ total: number }>();
    return row?.total ?? 0;
  }
}

const DEDUPE_TABLE = "mailswitch_webhook_dedupe";

/**
 * A `DedupeStore` on a D1 database. Apply `D1_SCHEMA` first.
 *
 * One column, `expires_at`, holds the end of a lease or the end of a TTL. `claim` is one
 * upsert that takes the row only when it is missing or expired. `RETURNING` tells the
 * caller whether this call won. Each claim writes a random `lease_id`. `commit` and
 * `release` change the row only when its `lease_id` matches.
 */
export class D1DedupeStore implements DedupeStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new TypeError("D1DedupeStore needs a D1 database binding.");
    }
    this.#db = db;
  }

  async claim(input: DedupeClaimInput): Promise<DedupeClaimOutcome> {
    const [outcome] = await this.#claimAll([input.key], input.leaseMs, input.now);
    if (!outcome) throw new Error("D1DedupeStore could not read the claimed row.");
    return outcome;
  }

  async commit(input: DedupeCommitInput): Promise<boolean> {
    const result = await this.#commitStatement(
      input.key,
      input.leaseId,
      input.now + input.ttlMs,
    ).run();
    return changes(result) > 0;
  }

  async release(input: DedupeReleaseInput): Promise<void> {
    await this.#releaseStatement(input.key, input.leaseId).run();
  }

  /**
   * Claims every key in one batch. D1 runs a batch as one transaction, so a failed
   * statement rolls back the claims of every key in the call.
   */
  async claimMany(input: DedupeClaimManyInput): Promise<DedupeClaimOutcome[]> {
    assertDistinctKeys(input.keys);
    if (input.keys.length === 0) return [];
    return this.#claimAll(input.keys, input.leaseMs, input.now);
  }

  /** Commits every lease in one batch. A failed statement rolls back every commit. */
  async commitMany(input: DedupeCommitManyInput): Promise<boolean[]> {
    if (input.leases.length === 0) return [];
    const expiresAt = input.now + input.ttlMs;
    const results = await this.#db.batch(
      input.leases.map((lease) => this.#commitStatement(lease.key, lease.leaseId, expiresAt)),
    );
    return input.leases.map((_, i) => changes(results[i]) > 0);
  }

  /** Releases every lease in one batch. */
  async releaseMany(leases: readonly DedupeReleaseInput[]): Promise<void> {
    if (leases.length === 0) return;
    await this.#db.batch(leases.map((lease) => this.#releaseStatement(lease.key, lease.leaseId)));
  }

  // Each key has two statements: an upsert that takes the row only when it is missing or
  // expired, then a read of the row. `RETURNING` tells whether the upsert won.
  async #claimAll(
    keys: readonly string[],
    leaseMs: number,
    now: number,
  ): Promise<DedupeClaimOutcome[]> {
    const db = this.#db;
    const leaseIds = keys.map(() => crypto.randomUUID());
    const statements = keys.flatMap((key, i) => [
      db
        .prepare(
          `INSERT INTO ${DEDUPE_TABLE} (key, committed, expires_at, lease_id) VALUES (?1, 0, ?2 + ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET committed = 0, expires_at = excluded.expires_at,
             lease_id = excluded.lease_id
           WHERE ${DEDUPE_TABLE}.expires_at <= ?2
           RETURNING key`,
        )
        .bind(key, now, leaseMs, leaseIds[i]),
      db.prepare(`SELECT committed FROM ${DEDUPE_TABLE} WHERE key = ?1`).bind(key),
    ]);
    const results = await db.batch<{ committed?: number }>(statements);
    return keys.map((_, i): DedupeClaimOutcome => {
      const leaseId = leaseIds[i] as string;
      if ((results[i * 2]?.results?.length ?? 0) > 0) return { status: "new", leaseId };
      const committed = results[i * 2 + 1]?.results?.[0]?.committed;
      return { status: committed === 1 ? "duplicate" : "in_flight" };
    });
  }

  #commitStatement(key: string, leaseId: string, expiresAt: number): D1StatementLike {
    return this.#db
      .prepare(
        `INSERT INTO ${DEDUPE_TABLE} (key, committed, expires_at, lease_id) VALUES (?1, 1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET committed = 1, expires_at = excluded.expires_at
         WHERE ${DEDUPE_TABLE}.lease_id = excluded.lease_id`,
      )
      .bind(key, expiresAt, leaseId);
  }

  #releaseStatement(key: string, leaseId: string): D1StatementLike {
    return this.#db
      .prepare(`DELETE FROM ${DEDUPE_TABLE} WHERE key = ?1 AND committed = 0 AND lease_id = ?2`)
      .bind(key, leaseId);
  }

  async purgeExpired(now: number): Promise<number> {
    const result = await this.#db
      .prepare(`DELETE FROM ${DEDUPE_TABLE} WHERE expires_at <= ?1`)
      .bind(now)
      .run();
    return changes(result);
  }
}
