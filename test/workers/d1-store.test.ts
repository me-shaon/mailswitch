import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { applyD1Schema, D1IdempotencyStore } from "../../src/stores/d1";
import { idempotencyBulkSuite, idempotencyStoreSuite } from "../stores/store-suite";

const db = (env as unknown as { DB: D1Database }).DB;

async function freshStore(): Promise<D1IdempotencyStore> {
  await applyD1Schema(db);
  await db.prepare("DELETE FROM mailswitch_idempotency").run();
  return new D1IdempotencyStore(db);
}

idempotencyStoreSuite("D1", async () => ({
  store: await freshStore(),
  rawRow: (key) =>
    db.prepare("SELECT * FROM mailswitch_idempotency WHERE key = ?").bind(key).first(),
}));
idempotencyBulkSuite("D1", async () => ({ store: await freshStore() }));

it("rolls back every claim of a claimMany call when one statement fails", async () => {
  const store = await freshStore();
  // No claim value can break the CHECK constraint, so a test-only trigger fails one insert.
  await db
    .prepare(
      `CREATE TRIGGER fail_boom BEFORE INSERT ON mailswitch_idempotency
       WHEN NEW.key = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    )
    .run();
  const claim = (key: string) => ({
    key,
    payloadHash: "h",
    claimId: `c-${key}`,
    now: 1_000,
    pendingTimeoutMs: 60_000,
  });
  try {
    await expect(store.claimMany([claim("a"), claim("boom"), claim("c")])).rejects.toThrow(/boom/);
  } finally {
    await db.prepare("DROP TRIGGER fail_boom").run();
  }
  const rows = await db
    .prepare("SELECT COUNT(*) AS n FROM mailswitch_idempotency")
    .first<{ n: number }>();
  expect(rows?.n).toBe(0);
  const after = await store.claimMany([claim("a"), claim("c")]);
  expect(after.map((outcome) => outcome.kind)).toEqual(["claimed", "claimed"]);
});

it("refuses an invalid state with the CHECK constraint", async () => {
  await applyD1Schema(db);
  await expect(
    db
      .prepare(
        "INSERT INTO mailswitch_idempotency (key, payload_hash, state, claim_id, claimed_at, updated_at) VALUES ('x', 'h', 'done', 'c', 1, 1)",
      )
      .run(),
  ).rejects.toThrow();
});

it("refuses a value that is not a D1 binding", () => {
  expect(() => new D1IdempotencyStore({} as never)).toThrow(TypeError);
});
