import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { toSendBounce } from "../../src/conformance/fixtures/tosend";
import { utf8 } from "../../src/internal/encoding";
import { tosend } from "../../src/providers/tosend/index";
import { toSendSignature } from "../../src/providers/tosend/webhooks";
import { applyD1Schema, D1DedupeStore } from "../../src/stores/d1";
import { handleWebhook } from "../../src/webhooks/index";
import { dedupeStoreSuite } from "../stores/dedupe-suite";

const db = (env as unknown as { DB: D1Database }).DB;
const SECRET = "tosend-webhook-secret-0123456789";
const NOW = Date.parse("2026-10-26T12:00:30.000Z");

async function freshStore(): Promise<D1DedupeStore> {
  await applyD1Schema(db);
  await db.prepare("DELETE FROM mailswitch_webhook_dedupe").run();
  return new D1DedupeStore(db);
}

dedupeStoreSuite("D1", freshStore);

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
        "INSERT INTO mailswitch_webhook_dedupe (key, committed, expires_at) VALUES ('x', 2, 1)",
      )
      .run(),
  ).rejects.toThrow();
});

it("refuses a value that is not a D1 binding", () => {
  expect(() => new D1DedupeStore({} as never)).toThrow(TypeError);
});
