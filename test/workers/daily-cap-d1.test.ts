import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createMailer } from "../../src/index";
import { applyD1Schema, D1DailyCapStore, D1IdempotencyStore } from "../../src/stores/d1";
import { fakeProvider } from "../../src/testing/fake-provider";
import { dailyCapStoreSuite, T0 } from "../stores/daily-cap-suite";

const db = (env as unknown as { DB: D1Database }).DB;

async function freshStore(): Promise<D1DailyCapStore> {
  await applyD1Schema(db);
  await db.prepare("DELETE FROM mailswitch_daily_cap").run();
  return new D1DailyCapStore(db);
}

dailyCapStoreSuite("D1", freshStore);

it("refuses a negative bucket count with the CHECK constraint", async () => {
  await applyD1Schema(db);
  await expect(
    db
      .prepare("INSERT INTO mailswitch_daily_cap (scope, bucket_start, used) VALUES ('x', 1, -1)")
      .run(),
  ).rejects.toThrow();
});

it("refuses a value that is not a D1 binding", () => {
  expect(() => new D1DailyCapStore({} as never)).toThrow(TypeError);
});

it("deletes buckets that left the window on reserve", async () => {
  const store = await freshStore();
  await store.reserve({ scope: "old", cap: 5, now: T0 });
  await store.reserve({ scope: "old", cap: 5, now: T0 + 2 * 24 * 60 * 60 * 1000 });
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM mailswitch_daily_cap WHERE scope = 'old'")
    .first<{ n: number }>();
  expect(row?.n).toBe(1);
});

it("100 parallel sends with a cap of 100 and 99 used make exactly one call on D1", async () => {
  const dailyCaps = await freshStore();
  for (let i = 0; i < 99; i++) await dailyCaps.reserve({ scope: "fake", cap: 100, now: T0 });
  const fake = fakeProvider();
  const mailer = createMailer({
    providers: [{ adapter: fake, credentials: { apiKey: "fk_a" }, dailyCap: 100 }],
    dailyCaps,
    now: () => T0,
  });
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      mailer.send({
        from: "billing@example.com",
        to: ["ana@example.org"],
        subject: `Invoice ${i}`,
        text: "Body",
      }),
    ),
  );
  expect(fake.sends).toHaveLength(1);
  expect(results.filter((result) => result.status === "sent")).toHaveLength(1);
  expect(await dailyCaps.used("fake", T0)).toBe(100);
});

it("a cap refusal after a D1 claim writes the final state", async () => {
  const dailyCaps = await freshStore();
  await db.prepare("DELETE FROM mailswitch_idempotency").run();
  await dailyCaps.fill({ scope: "fake", cap: 1, now: T0 });
  const idempotency = new D1IdempotencyStore(db);
  const fake = fakeProvider();
  const mailer = createMailer({
    providers: [{ adapter: fake, credentials: { apiKey: "fk_a" }, dailyCap: 1 }],
    namespace: "app",
    idempotency,
    dailyCaps,
    now: () => T0,
  });
  const result = await mailer.send({
    from: "billing@example.com",
    to: ["ana@example.org"],
    subject: "Hi",
    text: "Body",
    idempotencyKey: "cap-d1",
  });
  expect(result).toMatchObject({ status: "not_sent", reason: "daily_cap" });
  expect(fake.sends).toHaveLength(0);
  expect((await idempotency.get("app:cap-d1"))?.state).toBe("not_sent");
});
