// D1 stores. D1 has a single writer and runs a batch as one transaction, so a conditional
// write is atomic. This file uses a structural D1 type, so it imports no Workers module.

import type {
  IdempotencyAppendInput,
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyState,
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
 * The schema of the idempotency table. Apply it with `applyD1Schema`, or copy it into a
 * migration. `src/stores/d1-schema.sql` holds the same text.
 */
export const D1_IDEMPOTENCY_SCHEMA = `CREATE TABLE IF NOT EXISTS mailswitch_idempotency (
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
`;

/** Runs each statement of a schema in one batch. The statements use `IF NOT EXISTS`. */
export async function applyD1Schema(
  db: D1DatabaseLike,
  schema: string = D1_IDEMPOTENCY_SCHEMA,
): Promise<void> {
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

/** An `IdempotencyStore` on a D1 database. Apply `D1_IDEMPOTENCY_SCHEMA` first. */
export class D1IdempotencyStore implements IdempotencyStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new TypeError("D1IdempotencyStore needs a D1 database binding.");
    }
    this.#db = db;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimOutcome> {
    const { key, payloadHash, claimId, now, pendingTimeoutMs } = input;
    const db = this.#db;
    // One batch is one transaction: insert a new claim, re-claim a free key, convert a
    // stale claim, then read the row. Only one of the three writes can apply.
    const results = await db.batch<Row>([
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
           WHERE key = ?1 AND state = 'pending' AND claimed_at < ?3`,
        )
        .bind(key, now, now - pendingTimeoutMs),
      db.prepare(`SELECT * FROM ${TABLE} WHERE key = ?1`).bind(key),
    ]);
    const row = results[3]?.results?.[0];
    if (!row) throw new Error("D1IdempotencyStore could not read the claimed row.");
    const record = toRecord(row);
    if (record.claimId === claimId && record.state === "pending") return { kind: "claimed" };
    if (record.payloadHash !== payloadHash) return { kind: "conflict", record };
    if (changes(results[2]) === 1) return { kind: "stale", record };
    if (record.state === "pending") return { kind: "pending", record };
    return { kind: "existing", record };
  }

  async appendAttempt(input: IdempotencyAppendInput): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `UPDATE ${TABLE} SET attempts = json_insert(attempts, '$[#]', json(?3)), updated_at = ?4
         WHERE ${FENCE}`,
      )
      .bind(input.key, input.claimId, JSON.stringify(input.attempt), input.now)
      .run();
    return changes(result) === 1;
  }

  async finish(input: IdempotencyFinishInput): Promise<boolean> {
    // Only `sent` and `not_sent` records expire. An `unknown` record stays until a release.
    const expiresAt = input.state === "unknown" ? null : (input.expiresAt ?? null);
    const result = await this.#db
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
      )
      .run();
    return changes(result) === 1;
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
