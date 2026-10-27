import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { toSendBounce } from "../../src/conformance/fixtures/tosend";
import { utf8 } from "../../src/internal/encoding";
import { tosend } from "../../src/providers/tosend/index";
import { toSendSignature } from "../../src/providers/tosend/webhooks";
import { applyD1Schema, D1DedupeStore } from "../../src/stores/d1";
import type { DedupeStore } from "../../src/stores/types";
import { handleWebhook } from "../../src/webhooks/index";
import { dedupeBulkSuite, dedupeStoreSuite } from "../stores/dedupe-suite";

const db = (env as unknown as { DB: D1Database }).DB;
const SECRET = "tosend-webhook-secret-0123456789";
const NOW = Date.parse("2026-10-26T12:00:30.000Z");

async function freshStore(): Promise<D1DedupeStore> {
  await applyD1Schema(db);
  await db.prepare("DELETE FROM mailswitch_webhook_dedupe").run();
  return new D1DedupeStore(db);
}

dedupeStoreSuite("D1", freshStore);
dedupeBulkSuite("D1", freshStore);

it("rolls back every claim of a claimMany call when one statement fails", async () => {
  const store = await freshStore();
  // No claim value can break the CHECK constraint, so a test-only trigger fails one insert.
  await db
    .prepare(
      `CREATE TRIGGER fail_boom BEFORE INSERT ON mailswitch_webhook_dedupe
       WHEN NEW.key = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    )
    .run();
  try {
    await expect(
      store.claimMany({ keys: ["a", "boom", "c"], leaseMs: 60_000, now: NOW }),
    ).rejects.toThrow(/boom/);
  } finally {
    await db.prepare("DROP TRIGGER fail_boom").run();
  }
  const rows = await db
    .prepare("SELECT COUNT(*) AS n FROM mailswitch_webhook_dedupe")
    .first<{ n: number }>();
  expect(rows?.n).toBe(0);
  const after = await store.claimMany({ keys: ["a", "c"], leaseMs: 60_000, now: NOW });
  expect(after.map((outcome) => outcome.status)).toEqual(["new", "new"]);
});

async function delivery(body: string): Promise<Request> {
  const bytes = utf8(body);
  return new Request("https://app.test/webhooks/tosend", {
    method: "POST",
    headers: { "x-tosend-signature": await toSendSignature(SECRET, bytes) },
    body: bytes,
  });
}

it("dedupes a toSend webhook in workerd with D1", async () => {
  const dedupe = await freshStore();
  const clock = { t: NOW };
  const options = { adapter: tosend(), secret: SECRET, dedupe, now: () => clock.t };
  const body = toSendBounce("ana@example.org");

  const first = await handleWebhook(await delivery(body), options);
  if (!first.ok) throw new Error(first.rejection);
  expect(first.events).toHaveLength(1);
  expect(await handleWebhook(await delivery(body), options)).toEqual({
    ok: false,
    rejection: "in_flight",
    status: 409,
  });
  await first.ack();
  const replay = await handleWebhook(await delivery(body), options);
  expect(replay.ok && replay.events).toEqual([]);

  const row = await db
    .prepare("SELECT key, committed, expires_at FROM mailswitch_webhook_dedupe")
    .first<{ key: string; committed: number; expires_at: number }>();
  expect(row?.key).toMatch(/^tosend:default:[0-9a-f]{64}$/);
  expect(row?.committed).toBe(1);
  expect(row?.expires_at).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
});

it("refuses a committed value that is not 0 or 1 with the CHECK constraint", async () => {
  await applyD1Schema(db);
  await expect(
    db
      .prepare(
        "INSERT INTO mailswitch_webhook_dedupe (key, committed, expires_at, lease_id) VALUES ('x', 2, 1, 'l')",
      )
      .run(),
  ).rejects.toThrow();
});

it("refuses a value that is not a D1 binding", () => {
  expect(() => new D1DedupeStore({} as never)).toThrow(TypeError);
});

it("keeps the bounce text out of the console, the dedupe calls, and the D1 rows", async () => {
  const canary = "cnry-bounce-reason-7f3a9c";
  const inner = await freshStore();
  // handleWebhook takes no logger or hooks. The console and the store are the only sinks.
  const calls: unknown[] = [];
  const dedupe: DedupeStore = {
    claim: (input) => {
      calls.push(input);
      return inner.claim(input);
    },
    commit: (input) => {
      calls.push(input);
      return inner.commit(input);
    },
    release: (input) => {
      calls.push(input);
      return inner.release(input);
    },
    purgeExpired: (now) => inner.purgeExpired(now),
    // The bulk methods too, so the test covers the path that the D1 store takes.
    claimMany: (input) => {
      calls.push(input);
      return inner.claimMany(input);
    },
    commitMany: (input) => {
      calls.push(input);
      return inner.commitMany(input);
    },
    releaseMany: (leases) => {
      calls.push(leases);
      return inner.releaseMany(leases);
    },
  };
  const body = JSON.parse(toSendBounce("ana@example.org")) as { data: Record<string, unknown> };
  body.data.reason = `smtp; 550 5.1.1 ${canary}`;
  const logs: unknown[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((method) => console[method]);
  for (const method of methods) console[method] = (...args: unknown[]) => logs.push(args);
  try {
    const options = { adapter: tosend(), secret: SECRET, dedupe, now: () => NOW };
    const result = await handleWebhook(await delivery(JSON.stringify(body)), options);
    if (!result.ok) throw new Error(result.rejection);
    expect(result.events[0]?.bounceDetail?.text).toBe(`smtp; 550 5.1.1 ${canary}`);
    await result.ack();
  } finally {
    methods.forEach((method, index) => {
      console[method] = saved[index] as (typeof console)[typeof method];
    });
  }
  const rows = await db.prepare("SELECT * FROM mailswitch_webhook_dedupe").all();
  expect(rows.results).toHaveLength(1);
  expect(JSON.stringify(rows.results)).not.toContain(canary);
  expect(JSON.stringify(calls)).not.toContain(canary);
  expect(JSON.stringify(logs)).not.toContain(canary);
});
