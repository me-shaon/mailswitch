import { describe, expect, it } from "vitest";
import { defineProvider, type SendContext } from "../../src/index";
import { fakeProvider } from "../../src/testing/index";

const ctx: SendContext = {
  fetch: async () => {
    throw new Error("The memory transport must not call fetch.");
  },
  timeoutMs: 1000,
  credentials: { apiKey: "fk_test" },
  now: 1_000,
};

const message = { from: "a@example.com", to: ["b@example.org"], subject: "Hi", text: "Hello" };

describe("fakeProvider (memory transport)", () => {
  it("records sends and returns sent by default", async () => {
    const fake = fakeProvider();
    expect(await fake.send(message, ctx)).toEqual({
      status: "sent",
      providerMessageId: "fake-1",
      provider: "fake",
    });
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]).toMatchObject({ message, at: 1_000 });
  });

  it("returns the configured outcomes in order, then sent", async () => {
    const fake = fakeProvider({ outcomes: ["not_sent", "unknown"] });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fake.send(message, ctx)).status);
    expect(statuses).toEqual(["not_sent", "unknown", "sent"]);
    fake.reset();
    expect(fake.sends).toHaveLength(0);
    expect((await fake.send(message, ctx)).status).toBe("not_sent");
  });

  it("takes an outcome function and a full result", async () => {
    const fake = fakeProvider({
      outcomes: (_message, call) =>
        call === 0
          ? { status: "not_sent", reason: "rate_limited", message: "Slow down.", retryAfterMs: 5 }
          : "sent",
    });
    expect(await fake.send(message, ctx)).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 5,
      provider: "fake",
    });
  });

  it("refuses an invalid or unsupported message without recording it", async () => {
    const fake = fakeProvider();
    const invalid = await fake.send({ ...message, to: [] }, ctx);
    expect(invalid).toMatchObject({ status: "not_sent", reason: "invalid_message" });
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@example.org`);
    const unsupported = await fake.send({ ...message, to: many }, ctx);
    expect(unsupported).toMatchObject({ status: "not_sent", reason: "unsupported" });
    expect(fake.sends).toHaveLength(0);
  });

  it("returns the configured verify result", async () => {
    const result = { ok: false, status: "not_sent", reason: "auth", message: "Bad key." } as const;
    expect(await fakeProvider().verify(ctx)).toEqual({ ok: true });
    expect(await fakeProvider({ verifyResult: result }).verify(ctx)).toEqual(result);
  });

  it("passes defineProvider", () => {
    const fake = fakeProvider({ id: "fake-two" });
    expect(defineProvider(fake)).toBe(fake);
    expect(fake.meta.id).toBe("fake-two");
  });
});

describe("defineProvider", () => {
  const fake = fakeProvider();

  it("throws for a missing send or verify", () => {
    expect(() => defineProvider({ ...fake, send: undefined as never })).toThrow(/send/);
    expect(() => defineProvider({ ...fake, verify: 1 as never })).toThrow(/verify/);
  });

  it("throws when webhooks and meta.webhooks disagree", () => {
    const { webhooks: _dropped, ...noHooks } = fake;
    expect(() => defineProvider(noHooks)).toThrow(/no webhooks methods/);
    const meta = { ...fake.meta, webhooks: false };
    expect(() => defineProvider({ ...fake, meta })).toThrow(/meta.webhooks is not true/);
  });

  it("throws for bad meta and a bad sendBatch", () => {
    expect(() => defineProvider({ ...fake, meta: { ...fake.meta, tier: 3 as never } })).toThrow(
      /tier/,
    );
    expect(() => defineProvider({ ...fake, sendBatch: "x" as never })).toThrow(/sendBatch/);
  });
});
