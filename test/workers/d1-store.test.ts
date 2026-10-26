import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { applyD1Schema, D1IdempotencyStore } from "../../src/stores/d1";
import { idempotencyStoreSuite } from "../stores/store-suite";

const db = (env as unknown as { DB: D1Database }).DB;

idempotencyStoreSuite("D1", async () => {
  await applyD1Schema(db);
  await db.prepare("DELETE FROM mailswitch_idempotency").run();
  return {
    store: new D1IdempotencyStore(db),
    rawRow: (key) =>
      db.prepare("SELECT * FROM mailswitch_idempotency WHERE key = ?").bind(key).first(),
  };
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
