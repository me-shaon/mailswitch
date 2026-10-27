import { describe, expect, it, vi } from "vitest";
import { mockFetch, type RecordedExchange } from "../../src/conformance/mock-fetch";
import { defineProvider, type ProviderAdapter } from "../../src/core/adapter";
import type { AttemptView } from "../../src/core/hooks";
import { defineProviderMeta } from "../../src/core/meta";
import { createMailer, type MailerOptions } from "../../src/core/pipeline";
import type { OutgoingMessage, SendResult } from "../../src/core/types";
import { resend } from "../../src/providers/resend/index";
import { TOSEND_API_BASE, tosend } from "../../src/providers/tosend/index";
import { MemoryDailyCapStore, MemoryIdempotencyStore } from "../../src/stores/memory";
import type { DailyCapStore, IdempotencyRecord } from "../../src/stores/types";
import { type FakeProviderOptions, fakeMeta, fakeProvider } from "../../src/testing/fake-provider";
import { T0 } from "../stores/daily-cap-suite";

const RESEND_URL = "https://api.resend.com/emails";
const TOSEND_URL = `${TOSEND_API_BASE}/v2/emails`;
const CANARY = "canary-7f3a9c@example.org";
const RESEND_KEY = "re_test_0123456789";
const TOSEND_KEY = "tsend_test0123456789";
const NAMESPACE = "app";

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: "Acme Billing <billing@example.com>",
    to: [CANARY],
    subject: "Invoice 42",
    text: "Your invoice is attached.",
    ...overrides,
  };
}

function exchange(url: string, response: RecordedExchange["response"]): RecordedExchange {
  return { label: url, method: "POST", url, response };
}

function callsTo(mock: ReturnType<typeof mockFetch>, url: string): number {
  return mock.calls.filter((call) => call.url === url).length;
}

/** A Resend primary and a toSend fallback over one mock fetch. */
function resendThenToSend(
  resendResponse: RecordedExchange["response"],
  extra: Partial<MailerOptions> = {},
) {
  const mock = mockFetch([
    exchange(RESEND_URL, resendResponse),
    exchange(TOSEND_URL, { status: 200, body: { message_id: "ts-1" } }),
  ]);
  const idempotency = new MemoryIdempotencyStore();
  const mailer = createMailer({
    providers: [
      { adapter: resend(), credentials: { apiKey: RESEND_KEY } },
      { adapter: tosend(), credentials: { apiKey: TOSEND_KEY } },
    ],
    namespace: NAMESPACE,
    idempotency,
    fetch: mock.fetch,
    timeoutMs: 1000,
    now: () => T0,
    ...extra,
  });
  return { mock, mailer, idempotency };
}

/** No message may have two `sent` attempts. */
function expectOneSentAtMost(record: IdempotencyRecord | null): void {
  const sent = record?.attempts.filter((attempt) => attempt.status === "sent") ?? [];
  expect(sent.length).toBeLessThanOrEqual(1);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createMailer: fallback", () => {
  it("AE1: a Resend timeout after the request is unknown, and toSend gets zero calls", async () => {
    const { mock, mailer, idempotency } = resendThenToSend("timeout");
    const result = await mailer.send(message({ idempotencyKey: "k1" }));
    expect(result.status).toBe("unknown");
    expect(result.provider).toBe("resend");
    expect(callsTo(mock, RESEND_URL)).toBe(1);
    expect(callsTo(mock, TOSEND_URL)).toBe(0);
    const record = await idempotency.get(`${NAMESPACE}:k1`);
    expect(record?.state).toBe("unknown");
    expect(record?.attempts).toHaveLength(1);
  });

  it("AE2: a Resend 401 falls back to toSend, and the record has two attempts", async () => {
    const { mock, mailer, idempotency } = resendThenToSend({
      status: 401,
      body: { name: "invalid_api_key", message: "API key is invalid" },
    });
    const result = await mailer.send(message({ idempotencyKey: "k2" }));
    expect(result).toMatchObject({ status: "sent", provider: "tosend" });
    expect(callsTo(mock, RESEND_URL)).toBe(1);
    expect(callsTo(mock, TOSEND_URL)).toBe(1);
    const record = await idempotency.get(`${NAMESPACE}:k2`);
    expect(record?.state).toBe("sent");
    expect(record?.attempts.map((a) => [a.provider, a.status, a.reason])).toEqual([
      ["resend", "not_sent", "auth"],
      ["tosend", "sent", undefined],
    ]);
    expectOneSentAtMost(record);
  });

  it("stops after sent and makes no second call", async () => {
    const { mock, mailer } = resendThenToSend({ status: 200, body: { id: "re-1" } });
    const result = await mailer.send(message());
    expect(result).toMatchObject({ status: "sent", provider: "resend" });
    expect(callsTo(mock, TOSEND_URL)).toBe(0);
  });

  it("returns the last not_sent result when every provider refuses", async () => {
    const a = fakeProvider({ id: "a", outcomes: ["not_sent"] });
    const b = fakeProvider({ id: "b", outcomes: ["not_sent"] });
    const idempotency = new MemoryIdempotencyStore();
    const mailer = createMailer({
      providers: [
        { adapter: a, credentials: { apiKey: "fk_a" } },
        { adapter: b, credentials: { apiKey: "fk_b" } },
      ],
      namespace: NAMESPACE,
      idempotency,
    });
    const result = await mailer.send(message({ idempotencyKey: "all" }));
    expect(result).toMatchObject({ status: "not_sent", provider: "b" });
    expect((await idempotency.get(`${NAMESPACE}:all`))?.state).toBe("not_sent");
  });

  it("a shouldFallback that returns false stops after not_sent", async () => {
    const { mock, mailer } = resendThenToSend(
      { status: 401, body: { name: "invalid_api_key" } },
      { shouldFallback: (result) => result.reason !== "auth" },
    );
    const result = await mailer.send(message());
    expect(result).toMatchObject({ status: "not_sent", reason: "auth", provider: "resend" });
    expect(callsTo(mock, TOSEND_URL)).toBe(0);
  });

  it("ignores a shouldFallback that returns true for unknown, and warns", async () => {
    const warn = vi.fn();
    const { mock, mailer } = resendThenToSend("timeout", {
      shouldFallback: () => true,
      logger: { warn },
    });
    const result = await mailer.send(message({ idempotencyKey: "k3" }));
    expect(result.status).toBe("unknown");
    expect(callsTo(mock, TOSEND_URL)).toBe(0);
    expect(warn.mock.calls.some(([text]) => String(text).includes("shouldFallback"))).toBe(true);
  });

  it("treats a thrown adapter error as unknown/provider_error and records it", async () => {
    const thrower = defineProvider({
      ...fakeProvider({ id: "thrower" }),
      send: async () => {
        throw new Error("adapter bug");
      },
    });
    const fallback = fakeProvider({ id: "b" });
    const idempotency = new MemoryIdempotencyStore();
    const mailer = createMailer({
      providers: [
        { adapter: thrower, credentials: { apiKey: "fk_a" } },
        { adapter: fallback, credentials: { apiKey: "fk_b" } },
      ],
      namespace: NAMESPACE,
      idempotency,
    });
    const result = await mailer.send(message({ idempotencyKey: "boom" }));
    expect(result).toMatchObject({
      status: "unknown",
      reason: "provider_error",
      provider: "thrower",
    });
    expect(JSON.stringify(result)).not.toContain("adapter bug");
    expect(fallback.sends).toHaveLength(0);
    const record = await idempotency.get(`${NAMESPACE}:boom`);
    expect(record?.state).toBe("unknown");
    expect(record?.attempts[0]).toMatchObject({ provider: "thrower", reason: "provider_error" });
  });

  it("treats a malformed adapter result as unknown", async () => {
    const odd = defineProvider({
      ...fakeProvider({ id: "odd" }),
      send: async () => ({ status: "maybe" }) as unknown as SendResult,
    });
    const mailer = createMailer({ providers: [{ adapter: odd, credentials: { apiKey: "fk_a" } }] });
    expect(await mailer.send(message())).toMatchObject({ status: "unknown", provider: "odd" });
  });

  it("returns invalid_message before any claim or call", async () => {
    const a = fakeProvider({ id: "a" });
    const idempotency = new MemoryIdempotencyStore();
    const mailer = createMailer({
      providers: [{ adapter: a, credentials: { apiKey: "fk_a" } }],
      namespace: NAMESPACE,
      idempotency,
    });
    const result = await mailer.send(message({ subject: "a\r\nBcc: x@y.z", idempotencyKey: "v" }));
    expect(result).toMatchObject({ status: "not_sent", reason: "invalid_message" });
    expect(a.sends).toHaveLength(0);
    expect(await idempotency.get(`${NAMESPACE}:v`)).toBeNull();
  });
});

describe("createMailer: idempotency", () => {
  it("a retry with K during the fallback returns unknown with zero calls", async () => {
    const primary = fakeProvider({ id: "a", outcomes: ["not_sent"] });
    const gate = deferred<void>();
    const started = deferred<void>();
    let fallbackCalls = 0;
    const base = fakeProvider({ id: "slow" });
    const slow: ProviderAdapter = defineProvider({
      ...base,
      send: async (msg, ctx) => {
        fallbackCalls++;
        started.resolve();
        await gate.promise;
        return base.send(msg, ctx);
      },
    });
    const idempotency = new MemoryIdempotencyStore();
    const mailer = createMailer({
      providers: [
        { adapter: primary, credentials: { apiKey: "fk_a" } },
        { adapter: slow, credentials: { apiKey: "fk_b" } },
      ],
      namespace: NAMESPACE,
      idempotency,
    });
    const first = mailer.send(message({ idempotencyKey: "K" }));
    await started.promise;
    const retry = await mailer.send(message({ idempotencyKey: "K" }));
    expect(retry).toMatchObject({ status: "unknown", reason: "in_flight" });
    expect(primary.sends).toHaveLength(1);
    expect(fallbackCalls).toBe(1);
    gate.resolve();
    expect(await first).toMatchObject({ status: "sent", provider: "slow" });
    const record = await idempotency.get(`${NAMESPACE}:K`);
    expect(record?.attempts).toHaveLength(2);
    expectOneSentAtMost(record);
  });

  it("a repeat after sent returns the stored result with zero calls", async () => {
    const a = fakeProvider({ id: "a" });
    const idempotency = new MemoryIdempotencyStore();
    const mailer = createMailer({
      providers: [{ adapter: a, credentials: { apiKey: "fk_a" } }],
      namespace: NAMESPACE,
      idempotency,
    });
    const one = await mailer.send(message({ idempotencyKey: "r" }));
    const two = await mailer.send(message({ idempotencyKey: "r" }));
    expect(two).toEqual(one);
    expect(a.sends).toHaveLength(1);
  });

  it("sends a keyed message with no claim when no store is set", async () => {
    const a = fakeProvider({ id: "a" });
    const mailer = createMailer({ providers: [{ adapter: a, credentials: { apiKey: "fk_a" } }] });
    await mailer.send(message({ idempotencyKey: "x" }));
    expect(a.sends).toHaveLength(1);
  });
});

describe("createMailer: daily caps", () => {
  function capped(
    outcomes: FakeProviderOptions["outcomes"],
    cap = 5,
    extra: Partial<MailerOptions> = {},
  ) {
    const a = fakeProvider({ id: "a", outcomes });
    const dailyCaps = new MemoryDailyCapStore();
    const idempotency = new MemoryIdempotencyStore();
    const mailer = createMailer({
      providers: [{ adapter: a, credentials: { apiKey: "fk_a" }, dailyCap: cap }],
      namespace: NAMESPACE,
      idempotency,
      dailyCaps,
      now: () => T0,
      ...extra,
    });
    return { a, mailer, dailyCaps, idempotency };
  }

  it("AE4: a cap of 100 with 100 used returns not_sent/daily_cap with zero calls", async () => {
    const mock = mockFetch([exchange(RESEND_URL, { status: 200, body: { id: "re-1" } })]);
    const dailyCaps = new MemoryDailyCapStore();
    await dailyCaps.fill({ scope: "resend", cap: 100, now: T0 - 60_000 });
    const mailer = createMailer({
      providers: [{ adapter: resend(), credentials: { apiKey: RESEND_KEY }, dailyCap: 100 }],
      dailyCaps,
      fetch: mock.fetch,
      now: () => T0,
    });
    const result = await mailer.send(message());
    expect(result).toMatchObject({ status: "not_sent", reason: "daily_cap", provider: "resend" });
    expect(result.status === "not_sent" && result.resetAt).toBeGreaterThan(T0);
    expect(mock.calls).toHaveLength(0);
  });

  it("a primary at its cap falls back to toSend", async () => {
    const mock = mockFetch([
      exchange(RESEND_URL, { status: 200, body: { id: "re-1" } }),
      exchange(TOSEND_URL, { status: 200, body: { message_id: "ts-1" } }),
    ]);
    const dailyCaps = new MemoryDailyCapStore();
    await dailyCaps.fill({ scope: "resend", cap: 10, now: T0 });
    const views: AttemptView[] = [];
    const mailer = createMailer({
      providers: [
        { adapter: resend(), credentials: { apiKey: RESEND_KEY }, dailyCap: 10 },
        { adapter: tosend(), credentials: { apiKey: TOSEND_KEY } },
      ],
      dailyCaps,
      fetch: mock.fetch,
      now: () => T0,
      onAttempt: (view) => {
        views.push(view);
      },
      logger: { warn: () => {} },
    });
    const result = await mailer.send(message());
    expect(result).toMatchObject({ status: "sent", provider: "tosend" });
    expect(callsTo(mock, RESEND_URL)).toBe(0);
    expect(callsTo(mock, TOSEND_URL)).toBe(1);
    expect(views.map((view) => [view.provider, view.status, view.reason])).toEqual([
      ["resend", "not_sent", "daily_cap"],
      ["tosend", "sent", undefined],
    ]);
  });

  it("a duplicate key uses no cap unit", async () => {
    const { a, mailer, dailyCaps } = capped(["sent"]);
    await mailer.send(message({ idempotencyKey: "dup" }));
    await mailer.send(message({ idempotencyKey: "dup" }));
    expect(a.sends).toHaveLength(1);
    expect(await dailyCaps.used("a", T0)).toBe(1);
  });

  it("an unknown result keeps its unit, and a not_sent result refunds it", async () => {
    const { mailer, dailyCaps } = capped(["unknown", "not_sent"]);
    expect((await mailer.send(message())).status).toBe("unknown");
    expect(await dailyCaps.used("a", T0)).toBe(1);
    expect((await mailer.send(message())).status).toBe("not_sent");
    expect(await dailyCaps.used("a", T0)).toBe(1);
  });

  it("a provider quota answer fills the counter", async () => {
    const quota: SendResult = {
      status: "not_sent",
      reason: "quota",
      message: "Daily quota exceeded.",
      httpStatus: 429,
    };
    const { a, mailer, dailyCaps } = capped([quota], 50);
    expect((await mailer.send(message())).status).toBe("not_sent");
    expect(await dailyCaps.used("a", T0)).toBe(50);
    expect(await mailer.send(message())).toMatchObject({ reason: "daily_cap" });
    expect(a.sends).toHaveLength(1);
  });

  it("100 parallel sends with a cap of 100 and 99 used make exactly one call (memory)", async () => {
    const { a, mailer, dailyCaps } = capped(undefined, 100);
    for (let i = 0; i < 99; i++) await dailyCaps.reserve({ scope: "a", cap: 100, now: T0 });
    const results = await Promise.all(Array.from({ length: 100 }, () => mailer.send(message())));
    expect(a.sends).toHaveLength(1);
    expect(results.filter((result) => result.status === "sent")).toHaveLength(1);
    expect(
      results.filter((result) => "reason" in result && result.reason === "daily_cap"),
    ).toHaveLength(99);
  });

  it("a cap refusal after a claim writes the final state not_sent", async () => {
    const { mailer, dailyCaps, idempotency } = capped(["sent"], 1);
    await dailyCaps.fill({ scope: "a", cap: 1, now: T0 });
    const result = await mailer.send(message({ idempotencyKey: "cap" }));
    expect(result).toMatchObject({ status: "not_sent", reason: "daily_cap" });
    const record = await idempotency.get(`${NAMESPACE}:cap`);
    expect(record?.state).toBe("not_sent");
    expect(record?.attempts).toEqual([
      { provider: "a", status: "not_sent", reason: "daily_cap", at: T0 },
    ]);
  });

  it("a cap store that throws gives not_sent/store_error and writes a final state", async () => {
    const broken: DailyCapStore = {
      reserve: async () => {
        throw new Error("D1 down");
      },
      release: async () => {},
      fill: async () => {},
      used: async () => 0,
    };
    const { idempotency, mailer } = capped(["sent"], 5, { dailyCaps: broken });
    expect(await mailer.send(message({ idempotencyKey: "down" }))).toMatchObject({
      status: "not_sent",
      reason: "store_error",
    });
    const record = await idempotency.get(`${NAMESPACE}:down`);
    expect(record?.state).toBe("not_sent");
  });

  it("uses the preset default daily cap when a cap store is set", async () => {
    const base = fakeMeta("preset");
    const meta = defineProviderMeta({
      ...base,
      presets: [{ id: "free", name: "Free", fixed: {}, defaultDailyCap: 1 }],
    });
    const fake = fakeProvider({ id: "preset" });
    const adapter = defineProvider({ ...fake, meta });
    const dailyCaps = new MemoryDailyCapStore();
    const mailer = createMailer({
      providers: [{ adapter, credentials: { apiKey: "fk_a" }, preset: "free" }],
      dailyCaps,
      now: () => T0,
    });
    expect((await mailer.send(message())).status).toBe("sent");
    expect(await mailer.send(message())).toMatchObject({ reason: "daily_cap" });
  });
});

describe("createMailer: capability check", () => {
  it("refuses a provider that cannot send the message, writes a final state, and falls back", async () => {
    const base = fakeMeta("plain");
    const meta = defineProviderMeta({
      ...base,
      capabilities: { ...base.capabilities, attachments: false },
    });
    const fake = fakeProvider({ id: "plain" });
    const plain = defineProvider({ ...fake, meta });
    const idempotency = new MemoryIdempotencyStore();
    const withAttachment = message({
      idempotencyKey: "att",
      attachments: [
        { filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array([1]) },
      ],
    });

    const single = createMailer({
      providers: [{ adapter: plain, credentials: { apiKey: "fk_a" } }],
      namespace: NAMESPACE,
      idempotency,
    });
    expect(await single.send(withAttachment)).toMatchObject({
      status: "not_sent",
      reason: "unsupported",
      provider: "plain",
    });
    expect(fake.sends).toHaveLength(0);
    const record = await idempotency.get(`${NAMESPACE}:att`);
    expect(record?.state).toBe("not_sent");
    expect(record?.attempts[0]).toMatchObject({ provider: "plain", reason: "unsupported" });

    const other = fakeProvider({ id: "full" });
    const chain = createMailer({
      providers: [
        { adapter: plain, credentials: { apiKey: "fk_a" } },
        { adapter: other, credentials: { apiKey: "fk_b" } },
      ],
      namespace: NAMESPACE,
      idempotency,
    });
    expect(await chain.send(withAttachment)).toMatchObject({ status: "sent", provider: "full" });
  });
});

describe("createMailer: hooks", () => {
  it("an onAttempt that throws leaves the result sent and logs a warning", async () => {
    const warn = vi.fn();
    const mailer = createMailer({
      providers: [{ adapter: fakeProvider(), credentials: { apiKey: "fk_a" } }],
      onAttempt: () => {
        throw new Error("hook failed");
      },
      logger: { warn },
    });
    expect((await mailer.send(message())).status).toBe("sent");
    expect(warn).toHaveBeenCalled();
  });

  it("an async onAttempt that rejects leaves the result sent", async () => {
    const mailer = createMailer({
      providers: [{ adapter: fakeProvider(), credentials: { apiKey: "fk_a" } }],
      onAttempt: async () => {
        throw new Error("hook failed");
      },
    });
    expect((await mailer.send(message())).status).toBe("sent");
  });

  it("gives onAttempt only the redacted view", async () => {
    const views: AttemptView[] = [];
    const mailer = createMailer({
      providers: [{ adapter: fakeProvider(), credentials: { apiKey: "fk_a" } }],
      now: () => T0,
      onAttempt: (view) => {
        views.push(view);
      },
    });
    await mailer.send(message({ idempotencyKey: "view" }));
    expect(views).toEqual([{ provider: "fake", status: "sent", at: T0, messageKey: "view" }]);
  });

  it("never puts the canary recipient in onAttempt or logger payloads", async () => {
    const seen: unknown[] = [];
    const logger = { warn: (text: string, data?: unknown) => seen.push(text, data) };
    const { mailer } = resendThenToSend(
      { status: 401, body: { name: "invalid_api_key", message: `bad key for ${CANARY}` } },
      {
        idempotency: undefined,
        logger,
        shouldFallback: () => true,
        onAttempt: (view) => {
          seen.push(view);
          throw new Error(`hook saw ${CANARY}`);
        },
      },
    );
    const results = [
      await mailer.send(message({ cc: [CANARY], idempotencyKey: "c1" })),
      await mailer.send(message({ bcc: [`Canary <${CANARY}>`] })),
    ];
    expect(seen.length).toBeGreaterThan(2);
    expect(JSON.stringify(seen)).not.toContain(CANARY);
    expect(JSON.stringify(results)).not.toContain(CANARY);
  });
});

describe("createMailer: options", () => {
  const a = () => ({ adapter: fakeProvider({ id: "a" }), credentials: { apiKey: "fk_a" } });
  const b = () => ({ adapter: fakeProvider({ id: "b" }), credentials: { apiKey: "fk_b" } });

  it("throws when the pending timeout is below the floor", () => {
    expect(() =>
      createMailer({ providers: [a(), b()], timeoutMs: 10_000, pendingTimeoutMs: 19_999 }),
    ).toThrow(RangeError);
    expect(() =>
      createMailer({ providers: [a(), b()], timeoutMs: 10_000, pendingTimeoutMs: 20_000 }),
    ).not.toThrow();
  });

  it("throws for an empty chain, a missing namespace, or a cap with no store", () => {
    expect(() => createMailer({ providers: [] })).toThrow(TypeError);
    expect(() =>
      createMailer({ providers: [a()], idempotency: new MemoryIdempotencyStore() }),
    ).toThrow(/namespace/);
    expect(() =>
      createMailer({
        providers: [a()],
        idempotency: new MemoryIdempotencyStore(),
        namespace: "has:colon",
      }),
    ).toThrow(TypeError);
    expect(() => createMailer({ providers: [{ ...a(), dailyCap: 5 }] })).toThrow(/dailyCaps/);
    expect(() => createMailer({ providers: [{ ...a(), preset: "nope" }] })).toThrow(
      /invalid credentials: preset \(preset\)/,
    );
    expect(() =>
      createMailer({
        providers: [{ ...a(), dailyCap: 0 }],
        dailyCaps: new MemoryDailyCapStore(),
      }),
    ).toThrow(RangeError);
  });

  it("throws for a cap scope used twice", () => {
    expect(() =>
      createMailer({
        providers: [
          { ...a(), dailyCap: 5, scope: "x" },
          { ...b(), dailyCap: 5, scope: "x" },
        ],
        dailyCaps: new MemoryDailyCapStore(),
      }),
    ).toThrow(/scope/);
  });

  it("throws for invalid credentials and names the field, not the value", () => {
    let text = "";
    try {
      createMailer({
        providers: [{ adapter: resend(), credentials: { apiKey: "sk_live_wrong_secret" } }],
      });
    } catch (error) {
      text = String(error);
    }
    expect(text).toContain("apiKey (pattern)");
    expect(text).not.toContain("sk_live_wrong_secret");
  });

  it("warns at construction when a non-native provider has no idempotency store", () => {
    const warn = vi.fn();
    createMailer({
      providers: [{ adapter: tosend(), credentials: { apiKey: TOSEND_KEY } }],
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no native idempotency");

    const quiet = vi.fn();
    createMailer({
      providers: [{ adapter: tosend(), credentials: { apiKey: TOSEND_KEY } }],
      namespace: NAMESPACE,
      idempotency: new MemoryIdempotencyStore(),
      logger: { warn: quiet },
    });
    createMailer({ providers: [a()], logger: { warn: quiet } });
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("createMailer: a short native key window", () => {
  // A native provider that keeps a key for 30 minutes, as Brevo does.
  function shortWindow(windowMs = 30 * 60 * 1000) {
    const fake = fakeProvider({ id: "short" });
    const meta = defineProviderMeta({ ...fakeMeta("short"), nativeIdempotencyWindowMs: windowMs });
    return { adapter: defineProvider({ ...fake, meta }), credentials: { apiKey: "fk_a" } };
  }

  it("warns once when no idempotency store is set", () => {
    const warn = vi.fn();
    createMailer({ providers: [shortWindow()], logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("keeps an idempotency key for a short time");
  });

  it("warns for a short window in a fallback provider", () => {
    const warn = vi.fn();
    const primary = { adapter: fakeProvider({ id: "a" }), credentials: { apiKey: "fk_a" } };
    createMailer({ providers: [primary, shortWindow()], logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn with a store, or with a window of at least the sent retention", () => {
    const quiet = vi.fn();
    createMailer({
      providers: [shortWindow()],
      namespace: NAMESPACE,
      idempotency: new MemoryIdempotencyStore(),
      logger: { warn: quiet },
    });
    createMailer({ providers: [shortWindow(7 * 24 * 60 * 60 * 1000)], logger: { warn: quiet } });
    expect(quiet).not.toHaveBeenCalled();
  });

  it("writes one warning when the chain also has a provider with no native idempotency", () => {
    const warn = vi.fn();
    createMailer({
      providers: [shortWindow(), { adapter: tosend(), credentials: { apiKey: TOSEND_KEY } }],
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no native idempotency");
  });
});

describe("createMailer: claim fence", () => {
  it("does not call the fallback after a stale conversion and a release", async () => {
    let now = T0;
    const warn = vi.fn();
    const idempotency = new MemoryIdempotencyStore();
    const backup = fakeProvider({ id: "backup" });
    let calls = 0;
    const late: SendResult[] = [];
    const base = fakeProvider({ id: "a" });
    const primary: ProviderAdapter = defineProvider({
      ...base,
      send: async (msg, ctx) => {
        calls++;
        if (calls > 1) return base.send(msg, ctx);
        // The first attempt runs long. A retry finds the claim stale, an operator
        // releases the key, and a new send claims the key and sends.
        now += 2001;
        late.push(await mailer.send(msg));
        expect(await idempotency.release(`${NAMESPACE}:F`, { expectedState: "unknown" })).toBe(
          true,
        );
        late.push(await mailer.send(msg));
        return { status: "not_sent", reason: "auth", message: "Refused." };
      },
    });
    const mailer = createMailer({
      providers: [
        { adapter: primary, credentials: { apiKey: "fk_a" } },
        { adapter: backup, credentials: { apiKey: "fk_b" } },
      ],
      namespace: NAMESPACE,
      idempotency,
      timeoutMs: 1000,
      pendingTimeoutMs: 2000,
      now: () => now,
      logger: { warn },
    });
    const result = await mailer.send(message({ idempotencyKey: "F" }));
    expect(late[0]).toMatchObject({ status: "unknown", reason: "stale_pending" });
    expect(late[1]?.status).toBe("sent");
    expect(result).toMatchObject({ status: "unknown", reason: "stale_pending" });
    expect(backup.sends).toHaveLength(0);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
      "mailswitch: the claim was no longer current. The record did not change.",
    );
    // The record of the new claim stays as that claim wrote it.
    const record = await idempotency.get(`${NAMESPACE}:F`);
    expect(record?.state).toBe("sent");
    expect(record?.attempts).toHaveLength(1);
  });

  it("writes each attempt with the heartbeat before the next provider call", async () => {
    const idempotency = new MemoryIdempotencyStore();
    const touch = vi.spyOn(idempotency, "touch");
    const a = fakeProvider({ id: "a", outcomes: ["not_sent"] });
    const b = fakeProvider({ id: "b" });
    const mailer = createMailer({
      providers: [
        { adapter: a, credentials: { apiKey: "fk_a" } },
        { adapter: b, credentials: { apiKey: "fk_b" } },
      ],
      namespace: NAMESPACE,
      idempotency,
      now: () => T0,
    });
    await mailer.send(message({ idempotencyKey: "beat" }));
    expect(touch).toHaveBeenCalledTimes(2);
    expect(touch.mock.calls[0]?.[0].attempt).toBeUndefined();
    expect(touch.mock.calls[1]?.[0].attempt).toMatchObject({ provider: "a", status: "not_sent" });
  });
});

describe("createMailer: store failures", () => {
  it("returns the sent result and warns when the final record fails to write", async () => {
    const warn = vi.fn();
    const idempotency = new MemoryIdempotencyStore();
    idempotency.finish = async () => {
      throw new Error(`D1 down ${RESEND_KEY}`);
    };
    const a = fakeProvider({ id: "a" });
    const mailer = createMailer({
      providers: [{ adapter: a, credentials: { apiKey: "fk_a" } }],
      namespace: NAMESPACE,
      idempotency,
      now: () => T0,
      logger: { warn },
    });
    const result = await mailer.send(message({ idempotencyKey: "fin" }));
    expect(result).toMatchObject({ status: "sent", provider: "a" });
    expect(warn).toHaveBeenCalledWith("mailswitch: the store failed to write the final record.", {
      provider: "a",
      status: "sent",
      error: "Error",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(RESEND_KEY);
    // The claim stays pending, so a retry cannot send a second copy.
    expect((await idempotency.get(`${NAMESPACE}:fin`))?.state).toBe("pending");
  });

  it("returns not_sent/store_error when the claim throws, with no provider call", async () => {
    const idempotency = new MemoryIdempotencyStore();
    idempotency.claim = async () => {
      throw new Error("D1 down");
    };
    const a = fakeProvider({ id: "a" });
    const mailer = createMailer({
      providers: [{ adapter: a, credentials: { apiKey: "fk_a" } }],
      namespace: NAMESPACE,
      idempotency,
    });
    expect(await mailer.send(message({ idempotencyKey: "c" }))).toMatchObject({
      status: "not_sent",
      reason: "store_error",
    });
    expect(a.sends).toHaveLength(0);
  });

  it("keeps the provider result when a store fails before the fallback", async () => {
    const idempotency = new MemoryIdempotencyStore();
    const touch = idempotency.touch.bind(idempotency);
    let touches = 0;
    idempotency.touch = async (input) => {
      touches++;
      if (touches === 2) throw new Error("D1 down");
      return touch(input);
    };
    const a = fakeProvider({ id: "a", outcomes: ["not_sent"] });
    const b = fakeProvider({ id: "b" });
    const mailer = createMailer({
      providers: [
        { adapter: a, credentials: { apiKey: "fk_a" } },
        { adapter: b, credentials: { apiKey: "fk_b" } },
      ],
      namespace: NAMESPACE,
      idempotency,
    });
    const result = await mailer.send(message({ idempotencyKey: "fb" }));
    expect(result).toMatchObject({ status: "not_sent", provider: "a" });
    expect(b.sends).toHaveLength(0);
    expect((await idempotency.get(`${NAMESPACE}:fb`))?.state).toBe("not_sent");
  });
});
