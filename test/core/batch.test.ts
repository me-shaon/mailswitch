import { describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../src/conformance/mock-fetch";
import { defineProvider, type ProviderAdapter } from "../../src/core/adapter";
import { bucketExpiry } from "../../src/core/daily-cap";
import { createMailer, type MailerOptions, type MailerProvider } from "../../src/core/pipeline";
import type { OutgoingMessage, SendResult } from "../../src/core/types";
import { hasBulkDailyCap, hasBulkIdempotency } from "../../src/internal/bulk-methods";
import { resend } from "../../src/providers/resend/index";
import { MemoryDailyCapStore, MemoryIdempotencyStore } from "../../src/stores/memory";
import type {
  DailyCapReleaseInput,
  DailyCapReserveManyInput,
  DailyCapStore,
  IdempotencyClaimInput,
  IdempotencyFinishInput,
  IdempotencyStore,
  IdempotencyTouchInput,
  RateLimitStore,
} from "../../src/stores/types";
import { type FakeOutcome, fakeProvider } from "../../src/testing/fake-provider";
import { batchProvider } from "../fixtures/batch-provider";
import { T0 } from "../stores/daily-cap-suite";

const NAMESPACE = "app";
const RESEND_KEY = "re_test_0123456789";
const PDF = "JVBERi0xLjQK";

function message(to: string, overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: "Acme <billing@example.com>",
    to: [to],
    subject: "Invoice",
    text: "Hello.",
    ...overrides,
  };
}

const NOT_SENT: SendResult = {
  status: "not_sent",
  reason: "rejected",
  message: "Refused.",
};
const UNKNOWN: SendResult = {
  status: "unknown",
  reason: "provider_error",
  message: "Failed after the request.",
};

/**
 * A plain store object with only the single methods of a memory store. It keeps the
 * per-message path, so a test can patch or spy on a single method.
 */
function singleIdempotency(memory = new MemoryIdempotencyStore()): IdempotencyStore {
  return {
    claim: (input) => memory.claim(input),
    touch: (input) => memory.touch(input),
    finish: (input) => memory.finish(input),
    release: (key, options) => memory.release(key, options),
    get: (key) => memory.get(key),
    purgeExpired: (now) => memory.purgeExpired(now),
  };
}

/** A plain daily cap store with only the single methods. It keeps the per-message path. */
function singleCaps(memory = new MemoryDailyCapStore()): DailyCapStore {
  return {
    reserve: (input) => memory.reserve(input),
    release: (input) => memory.release(input),
    fill: (input) => memory.fill(input),
    used: (scope, now) => memory.used(scope, now),
  };
}

function mailer(providers: ProviderAdapter[], extra: Partial<MailerOptions> = {}) {
  return createMailer({
    providers: providers.map((adapter) => ({ adapter, credentials: { apiKey: "fk_test" } })),
    now: () => T0,
    timeoutMs: 1000,
    logger: { warn: () => {} },
    ...extra,
  });
}

describe("sendBatch: fallback", () => {
  it("sends only the not_sent message of a batch of 3 through the fallback", async () => {
    const primary = batchProvider({
      outcome: (to) => (to === "b@x.org" ? NOT_SENT : undefined) as never,
    });
    const fallback = fakeProvider({ id: "backup" });
    const results = await mailer([primary.adapter, fallback]).sendBatch([
      message("a@x.org"),
      message("b@x.org"),
      message("c@x.org"),
    ]);
    expect(primary.batches).toHaveLength(1);
    expect(primary.batches[0]).toHaveLength(3);
    expect(fallback.sends.map((s) => s.message.to[0])).toEqual(["b@x.org"]);
    expect(results.map((r) => [r.status, r.provider])).toEqual([
      ["sent", "batcher"],
      ["sent", "backup"],
      ["sent", "batcher"],
    ]);
  });

  it("does not fall back for an unknown message", async () => {
    const primary = batchProvider({
      outcome: (to) => (to === "b@x.org" ? UNKNOWN : undefined) as never,
    });
    const fallback = fakeProvider({ id: "backup" });
    const results = await mailer([primary.adapter, fallback]).sendBatch([
      message("a@x.org"),
      message("b@x.org"),
    ]);
    expect(fallback.sends).toHaveLength(0);
    expect(results.map((r) => r.status)).toEqual(["sent", "unknown"]);
  });

  it("gives unknown to every message when sendBatch throws or returns a bad list", async () => {
    const primary = batchProvider();
    primary.adapter.sendBatch = async () => {
      throw new Error("boom");
    };
    const fallback = fakeProvider({ id: "backup" });
    const results = await mailer([primary.adapter, fallback]).sendBatch([
      message("a@x.org"),
      message("b@x.org"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["unknown", "unknown"]);
    expect(fallback.sends).toHaveLength(0);
    primary.adapter.sendBatch = async () => [{ status: "sent" }];
    const short = await mailer([primary.adapter]).sendBatch([
      message("a@x.org"),
      message("b@x.org"),
    ]);
    expect(short.map((r) => r.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("sendBatch: routing", () => {
  it("makes one send call per message when the provider has no sendBatch", async () => {
    const outcomes: FakeOutcome[] = ["sent", "sent", "sent"];
    const provider = fakeProvider({ outcomes });
    const results = await mailer([provider]).sendBatch([
      message("a@x.org"),
      message("b@x.org"),
      message("c@x.org"),
    ]);
    expect(provider.sends.map((s) => s.message.to[0])).toEqual(["a@x.org", "b@x.org", "c@x.org"]);
    expect(results.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
  });

  it("splits the batch into chunks of batchSize", async () => {
    const primary = batchProvider({ batchSize: 2 });
    const results = await mailer([primary.adapter]).sendBatch(
      ["a", "b", "c", "d", "e"].map((n) => message(`${n}@x.org`)),
    );
    expect(primary.batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(results.map((r) => r.status === "sent" && r.providerMessageId)).toEqual([
      "batcher-a@x.org",
      "batcher-b@x.org",
      "batcher-c@x.org",
      "batcher-d@x.org",
      "batcher-e@x.org",
    ]);
  });

  it("returns results in input order, with invalid messages in place", async () => {
    const primary = batchProvider({
      outcome: (to) => (to === "a@x.org" ? NOT_SENT : undefined) as never,
    });
    const results = await mailer([primary.adapter]).sendBatch([
      message("a@x.org"),
      message("bad"),
      message("c@x.org", {
        attachments: [{ filename: "a.pdf", content: PDF, contentType: "application/pdf" }],
      }),
      message("d@x.org"),
    ]);
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.status)).toEqual(["not_sent", "not_sent", "sent", "sent"]);
    expect(results[1]?.status === "not_sent" && results[1].reason).toBe("invalid_message");
    expect(results[3]?.status === "sent" && results[3].providerMessageId).toBe("batcher-d@x.org");
    expect(await mailer([primary.adapter]).sendBatch([])).toEqual([]);
  });

  it("sends a Resend attachment message through send and the rest through one batch with no key", async () => {
    const mock = mockFetch([
      {
        label: "batch",
        method: "POST",
        url: "https://api.resend.com/emails/batch",
        response: { status: 200, body: { data: [{ id: "b-1" }, { id: "b-2" }] } },
      },
      {
        label: "single",
        method: "POST",
        url: "https://api.resend.com/emails",
        response: { status: 200, body: { id: "s-1" } },
      },
    ]);
    const mailer = createMailer({
      providers: [{ adapter: resend(), credentials: { apiKey: RESEND_KEY } }],
      namespace: NAMESPACE,
      idempotency: new MemoryIdempotencyStore(),
      fetch: mock.fetch,
      now: () => T0,
    });
    const results = await mailer.sendBatch([
      message("one@x.org", { idempotencyKey: "k-1" }),
      message("two@x.org", {
        idempotencyKey: "k-2",
        attachments: [{ filename: "a.pdf", content: PDF, contentType: "application/pdf" }],
      }),
      message("three@x.org", { idempotencyKey: "k-3" }),
    ]);
    expect(results.map((r) => r.status === "sent" && r.providerMessageId)).toEqual([
      "b-1",
      "s-1",
      "b-2",
    ]);
    const batches = mock.calls.filter((c) => c.url.endsWith("/emails/batch"));
    const singles = mock.calls.filter((c) => c.url.endsWith("/emails"));
    expect(batches).toHaveLength(1);
    expect(singles).toHaveLength(1);
    expect(batches[0]?.headers.get("idempotency-key")).toBeNull();
    expect(JSON.parse(batches[0]?.body ?? "[]")).toHaveLength(2);
    // The single send still carries the native key.
    expect(singles[0]?.headers.get("idempotency-key")).toBe("k-2");
  });
});

describe("sendBatch: idempotency", () => {
  it("claims each message and gives a duplicate key in one call unknown/in_flight", async () => {
    const primary = batchProvider();
    const idempotency = new MemoryIdempotencyStore();
    const m = mailer([primary.adapter], { namespace: NAMESPACE, idempotency });
    const results = await m.sendBatch([
      message("a@x.org", { idempotencyKey: "dup" }),
      message("a@x.org", { idempotencyKey: "dup" }),
      message("c@x.org", { idempotencyKey: "other" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["sent", "unknown", "sent"]);
    expect(results[1]?.status === "unknown" && results[1].reason).toBe("in_flight");
    expect(primary.batches[0]).toHaveLength(2);
    // A later call with the same key gets the stored result and makes no provider call.
    const again = await m.sendBatch([message("a@x.org", { idempotencyKey: "dup" })]);
    expect(again[0]?.status).toBe("sent");
    expect(primary.batches).toHaveLength(1);
    const record = await idempotency.get(`${NAMESPACE}:dup`);
    expect(record?.state).toBe("sent");
  });

  it("writes one final record per message after the fallback", async () => {
    const primary = batchProvider({
      outcome: (to) => (to === "b@x.org" ? NOT_SENT : undefined) as never,
    });
    const fallback = fakeProvider({ id: "backup" });
    const idempotency = singleIdempotency();
    expect(hasBulkIdempotency(idempotency)).toBe(false);
    const finish = vi.spyOn(idempotency, "finish");
    await mailer([primary.adapter, fallback], { namespace: NAMESPACE, idempotency }).sendBatch([
      message("a@x.org", { idempotencyKey: "k-a" }),
      message("b@x.org", { idempotencyKey: "k-b" }),
    ]);
    expect(finish).toHaveBeenCalledTimes(2);
    const b = finish.mock.calls.find((call) => call[0].attempts.length === 2)?.[0];
    expect(b?.attempts.map((a) => [a.provider, a.status])).toEqual([
      ["batcher", "not_sent"],
      ["backup", "sent"],
    ]);
  });

  it("warns once per mailer for a keyed batch with no store", async () => {
    const warn = vi.fn();
    const primary = batchProvider();
    const m = mailer([primary.adapter], { logger: { warn } });
    expect(warn).not.toHaveBeenCalled();
    await m.sendBatch([message("a@x.org")]);
    expect(warn).not.toHaveBeenCalled();
    await m.sendBatch([message("a@x.org", { idempotencyKey: "k" })]);
    await m.sendBatch([message("b@x.org", { idempotencyKey: "k2" })]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/batch/);
  });
});

describe("sendBatch: daily caps", () => {
  it("reserves one unit per message, refunds not_sent, and falls back at the cap", async () => {
    const primary = batchProvider({
      outcome: (to) => (to === "a@x.org" ? NOT_SENT : undefined) as never,
    });
    const fallback = fakeProvider({ id: "backup" });
    const dailyCaps = new MemoryDailyCapStore();
    const m = createMailer({
      providers: [
        { adapter: primary.adapter, credentials: { apiKey: "fk_test" }, dailyCap: 2 },
        { adapter: fallback, credentials: { apiKey: "fk_test" } },
      ],
      dailyCaps,
      now: () => T0,
      logger: { warn: () => {} },
    });
    const results = await m.sendBatch([message("a@x.org"), message("b@x.org"), message("c@x.org")]);
    // a and b reserve the 2 units. c hits the cap and goes to the fallback with no batch.
    expect(primary.batches[0]?.map((x) => x.to[0])).toEqual(["a@x.org", "b@x.org"]);
    expect(fallback.sends.map((s) => s.message.to[0])).toEqual(["a@x.org", "c@x.org"]);
    expect(results.map((r) => r.provider)).toEqual(["backup", "batcher", "backup"]);
    // a was refunded, so one unit is free.
    const next = await m.sendBatch([message("d@x.org")]);
    expect(next[0]?.provider).toBe("batcher");
  });
});

describe("sendBatch: input", () => {
  it("throws a TypeError for an argument that is not an array", async () => {
    const m = mailer([batchProvider().adapter]);
    await expect(m.sendBatch("a@x.org" as never)).rejects.toThrow(TypeError);
    await expect(m.sendBatch(undefined as never)).rejects.toThrow(
      "sendBatch expects an array of messages.",
    );
  });
});

describe("sendBatch: claim heartbeat", () => {
  /** A provider whose every call takes 900 ms of clock time and then runs `during`. */
  function slowProvider(
    clock: { now: number },
    batch: boolean,
    during: (list: readonly OutgoingMessage[]) => Promise<void>,
  ): ProviderAdapter {
    const base = batchProvider({ batchSize: 2 }).adapter;
    const send: ProviderAdapter["send"] = async (m, ctx) => {
      clock.now += 900;
      await during([m]);
      return base.send(m, ctx);
    };
    const { sendBatch, ...single } = base;
    if (!batch) return defineProvider({ ...single, send });
    return defineProvider({
      ...base,
      send,
      async sendBatch(list, ctx) {
        clock.now += 900;
        await during(list);
        return (sendBatch as NonNullable<ProviderAdapter["sendBatch"]>)(list, ctx);
      },
    });
  }

  for (const [path, store] of [
    ["batch chunks", "bulk"],
    ["batch chunks", "per-message"],
    ["single sends", "bulk"],
    ["single sends", "per-message"],
  ] as const) {
    it(`keeps the later claims of a long call pending, not stale (${path}, ${store} path)`, async () => {
      const clock = { now: T0 };
      const memory = new MemoryIdempotencyStore();
      const idempotency = store === "bulk" ? memory : singleIdempotency(memory);
      const probes: SendResult[] = [];
      const last = message("f@x.org", { idempotencyKey: "k-f" });
      const adapter = slowProvider(clock, path === "batch chunks", async (list) => {
        // A concurrent retry of the last message, while its own call runs.
        if (list.some((x) => x.to[0] === "f@x.org")) probes.push(await m.send(last));
      });
      const m = mailer([adapter], {
        namespace: NAMESPACE,
        idempotency,
        now: () => clock.now,
        pendingTimeoutMs: 1000,
      });
      const list = [
        ...["a", "b", "c", "d", "e"].map((x) =>
          message(`${x}@x.org`, { idempotencyKey: `k-${x}` }),
        ),
        last,
      ];
      const results = await m.sendBatch(list);
      // The call ran far past the pending timeout.
      expect(clock.now - T0).toBeGreaterThan(2000);
      expect(results.map((r) => r.status)).toEqual(Array(6).fill("sent"));
      expect(probes).toEqual([expect.objectContaining({ status: "unknown", reason: "in_flight" })]);
      expect((await memory.get(`${NAMESPACE}:k-f`))?.state).toBe("sent");
    });
  }
});

describe("sendBatch: store failures", () => {
  it("returns every result and warns when the final record fails to write", async () => {
    const warn = vi.fn();
    const idempotency = singleIdempotency();
    expect(hasBulkIdempotency(idempotency)).toBe(false);
    idempotency.finish = async () => {
      throw new Error("D1 down");
    };
    const primary = batchProvider();
    const results = await mailer([primary.adapter], {
      namespace: NAMESPACE,
      idempotency,
      logger: { warn },
    }).sendBatch([
      message("a@x.org", { idempotencyKey: "k-a" }),
      message("b@x.org", { idempotencyKey: "k-b" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(
      warn.mock.calls.filter(
        (call) => call[0] === "mailswitch: the store failed to write the final record.",
      ),
    ).toHaveLength(2);
  });

  it("stops only the message whose cap store throws and finishes every claim", async () => {
    const memory = new MemoryDailyCapStore();
    let reserves = 0;
    const dailyCaps: DailyCapStore = {
      reserve: async (input) => {
        reserves++;
        if (reserves === 2) throw new Error("D1 down");
        return memory.reserve(input);
      },
      release: (input) => memory.release(input),
      fill: (input) => memory.fill(input),
      used: (scope, now) => memory.used(scope, now),
    };
    const primary = batchProvider();
    const idempotency = singleIdempotency();
    expect(hasBulkIdempotency(idempotency)).toBe(false);
    expect(hasBulkDailyCap(dailyCaps)).toBe(false);
    const m = createMailer({
      providers: [{ adapter: primary.adapter, credentials: { apiKey: "fk_test" }, dailyCap: 10 }],
      dailyCaps,
      idempotency,
      namespace: NAMESPACE,
      now: () => T0,
      logger: { warn: () => {} },
    });
    const results = await m.sendBatch([
      message("a@x.org", { idempotencyKey: "k-a" }),
      message("b@x.org", { idempotencyKey: "k-b" }),
      message("c@x.org", { idempotencyKey: "k-c" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["sent", "not_sent", "sent"]);
    expect(results[1]).toMatchObject({ reason: "store_error" });
    expect(primary.batches[0]?.map((x) => x.to[0])).toEqual(["a@x.org", "c@x.org"]);
    expect((await idempotency.get(`${NAMESPACE}:k-a`))?.state).toBe("sent");
    expect((await idempotency.get(`${NAMESPACE}:k-b`))?.state).toBe("not_sent");
    expect((await idempotency.get(`${NAMESPACE}:k-c`))?.state).toBe("sent");
    expect(await memory.used("batcher", T0)).toBe(2);
  });

  it("refunds the cap unit of a message whose heartbeat fails before its chunk", async () => {
    const dailyCaps = singleCaps();
    const idempotency = singleIdempotency();
    expect(hasBulkIdempotency(idempotency) || hasBulkDailyCap(dailyCaps)).toBe(false);
    const touch = idempotency.touch.bind(idempotency);
    idempotency.touch = async (input) => {
      if (input.key === `${NAMESPACE}:k-b`) throw new Error("D1 down");
      return touch(input);
    };
    const primary = batchProvider();
    const m = createMailer({
      providers: [{ adapter: primary.adapter, credentials: { apiKey: "fk_test" }, dailyCap: 10 }],
      dailyCaps,
      idempotency,
      namespace: NAMESPACE,
      now: () => T0,
      logger: { warn: () => {} },
    });
    const results = await m.sendBatch([
      message("a@x.org", { idempotencyKey: "k-a" }),
      message("b@x.org", { idempotencyKey: "k-b" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["sent", "not_sent"]);
    expect(results[1]).toMatchObject({ reason: "store_error" });
    expect(primary.batches[0]?.map((x) => x.to[0])).toEqual(["a@x.org"]);
    expect(await dailyCaps.used("batcher", T0)).toBe(1);
    expect((await idempotency.get(`${NAMESPACE}:k-b`))?.state).toBe("not_sent");
  });
});

describe("sendBatch: store concurrency", () => {
  /** Wraps the store calls of memory stores. Counts the calls that run at the same time. */
  function countingStores() {
    const stats = { inFlight: 0, max: 0, calls: 0 };
    async function track<T>(work: () => Promise<T>): Promise<T> {
      stats.calls++;
      stats.inFlight++;
      stats.max = Math.max(stats.max, stats.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await work();
      } finally {
        stats.inFlight--;
      }
    }
    const memory = new MemoryIdempotencyStore();
    const idempotency: IdempotencyStore = {
      claim: (input) => track(() => memory.claim(input)),
      touch: (input) => track(() => memory.touch(input)),
      finish: (input) => track(() => memory.finish(input)),
      release: (key, options) => track(() => memory.release(key, options)),
      get: (key) => track(() => memory.get(key)),
      purgeExpired: (now) => memory.purgeExpired(now),
    };
    const caps = new MemoryDailyCapStore();
    const dailyCaps: DailyCapStore = {
      reserve: (input) => track(() => caps.reserve(input)),
      release: (input) => track(() => caps.release(input)),
      fill: (input) => track(() => caps.fill(input)),
      used: (scope, now) => caps.used(scope, now),
    };
    return { stats, memory, idempotency, caps, dailyCaps };
  }

  it("overlaps the store calls of a batch, at most 8 at once, and keeps the input order", async () => {
    const { stats, memory, idempotency, dailyCaps } = countingStores();
    const primary = batchProvider({ batchSize: 50 });
    const m = createMailer({
      providers: [{ adapter: primary.adapter, credentials: { apiKey: "fk_test" }, dailyCap: 100 }],
      dailyCaps,
      idempotency,
      namespace: NAMESPACE,
      now: () => T0,
      logger: { warn: () => {} },
    });
    const names = Array.from({ length: 30 }, (_, i) => `m${i}@x.org`);
    const results = await m.sendBatch(
      names.map((to, i) => message(to, { idempotencyKey: `k-${i}` })),
    );
    expect(hasBulkIdempotency(idempotency) || hasBulkDailyCap(dailyCaps)).toBe(false);
    expect(stats.max).toBeGreaterThan(1);
    expect(stats.max).toBeLessThanOrEqual(8);
    // One claim, one reserve, one heartbeat, and one final record per message.
    expect(stats.calls).toBe(30 * 4);
    expect(results.map((r) => r.status === "sent" && r.providerMessageId)).toEqual(
      names.map((to) => `batcher-${to}`),
    );
    expect(primary.batches[0]?.map((x) => x.to[0])).toEqual(names);
    expect((await memory.get(`${NAMESPACE}:k-29`))?.state).toBe("sent");
  });

  it("gives unknown/in_flight to a repeated key with concurrent store calls", async () => {
    const { idempotency } = countingStores();
    const primary = batchProvider();
    const m = mailer([primary.adapter], { namespace: NAMESPACE, idempotency });
    const results = await m.sendBatch([
      message("a@x.org", { idempotencyKey: "dup" }),
      message("b@x.org", { idempotencyKey: "other" }),
      message("a@x.org", { idempotencyKey: "dup" }),
      message("a@x.org", { idempotencyKey: "dup" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["sent", "sent", "unknown", "unknown"]);
    expect(results.slice(2).map((r) => r.status === "unknown" && r.reason)).toEqual([
      "in_flight",
      "in_flight",
    ]);
    expect(primary.batches[0]?.map((x) => x.to[0])).toEqual(["a@x.org", "b@x.org"]);
  });

  it("grants the last cap unit to exactly one message of a batch", async () => {
    const { caps, dailyCaps } = countingStores();
    for (let i = 0; i < 99; i++) await caps.reserve({ scope: "batcher", cap: 100, now: T0 });
    const primary = batchProvider({ batchSize: 100 });
    const fallback = fakeProvider({ id: "backup" });
    const m = createMailer({
      providers: [
        { adapter: primary.adapter, credentials: { apiKey: "fk_test" }, dailyCap: 100 },
        { adapter: fallback, credentials: { apiKey: "fk_test" } },
      ],
      dailyCaps,
      now: () => T0,
      logger: { warn: () => {} },
    });
    const results = await m.sendBatch(
      Array.from({ length: 100 }, (_, i) => message(`m${i}@x.org`)),
    );
    expect(results.filter((r) => r.provider === "batcher")).toHaveLength(1);
    expect(results.filter((r) => r.provider === "backup")).toHaveLength(99);
    expect(await caps.used("batcher", T0)).toBe(100);
  });
});

describe("sendBatch: bulk path", () => {
  const LOST = "mailswitch: the claim was no longer current. The record did not change.";

  /** Plain stores with every bulk method over memory stores. Each method is a spy. */
  function bulkStores() {
    const memory = new MemoryIdempotencyStore();
    const caps = new MemoryDailyCapStore();
    const idempotency = {
      claim: vi.fn((input: IdempotencyClaimInput) => memory.claim(input)),
      touch: vi.fn((input: IdempotencyTouchInput) => memory.touch(input)),
      finish: vi.fn((input: IdempotencyFinishInput) => memory.finish(input)),
      release: (key: string, options: { expectedState: "unknown" }) => memory.release(key, options),
      get: (key: string) => memory.get(key),
      purgeExpired: (now: number) => memory.purgeExpired(now),
      claimMany: vi.fn((inputs: readonly IdempotencyClaimInput[]) => memory.claimMany(inputs)),
      touchMany: vi.fn((inputs: readonly IdempotencyTouchInput[]) => memory.touchMany(inputs)),
      finishMany: vi.fn((inputs: readonly IdempotencyFinishInput[]) => memory.finishMany(inputs)),
    };
    const dailyCaps = {
      reserve: vi.fn((input: Parameters<DailyCapStore["reserve"]>[0]) => caps.reserve(input)),
      release: vi.fn((input: DailyCapReleaseInput) => caps.release(input)),
      fill: vi.fn((input: Parameters<DailyCapStore["fill"]>[0]) => caps.fill(input)),
      used: (scope: string, now: number) => caps.used(scope, now),
      reserveMany: vi.fn((input: DailyCapReserveManyInput) => caps.reserveMany(input)),
      releaseMany: vi.fn((inputs: readonly DailyCapReleaseInput[]) => caps.releaseMany(inputs)),
    };
    expect(hasBulkIdempotency(idempotency) && hasBulkDailyCap(dailyCaps)).toBe(true);
    return { memory, caps, idempotency, dailyCaps };
  }

  type Providers = (ProviderAdapter | Omit<MailerProvider, "credentials">)[];

  function capped(providers: Providers, extra: Partial<MailerOptions> = {}) {
    return createMailer({
      providers: providers.map((item) =>
        "adapter" in item
          ? { ...item, credentials: { apiKey: "fk_test" } }
          : { adapter: item, credentials: { apiKey: "fk_test" } },
      ),
      namespace: NAMESPACE,
      now: () => T0,
      timeoutMs: 1000,
      logger: { warn: () => {} },
      ...extra,
    });
  }

  const keyed = (names: readonly string[]) =>
    names.map((name) => message(`${name}@x.org`, { idempotencyKey: `k-${name}` }));
  const TEN = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const sizes = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => {
      const arg = call[0] as readonly unknown[] | { count: number };
      return Array.isArray(arg) ? arg.length : (arg as { count: number }).count;
    });

  it("gives a keyed batch of 10 the same results and records as the per-message path", async () => {
    const outcome = (to: string) =>
      (to === "c@x.org" ? NOT_SENT : to === "e@x.org" ? UNKNOWN : undefined) as never;
    const run = async (bulk: boolean) => {
      const stores = bulkStores();
      const primary = batchProvider({ outcome });
      const fallback = fakeProvider({ id: "backup" });
      const m = capped([{ adapter: primary.adapter, dailyCap: 100 }, fallback], {
        idempotency: bulk ? stores.idempotency : singleIdempotency(stores.memory),
        dailyCaps: bulk ? stores.dailyCaps : singleCaps(stores.caps),
      });
      const results = await m.sendBatch(keyed(TEN));
      const records = await Promise.all(
        TEN.map(async (name) => {
          const record = await stores.memory.get(`${NAMESPACE}:k-${name}`);
          return [record?.state, record?.attempts.map((a) => [a.provider, a.status])];
        }),
      );
      return { results, records, used: await stores.caps.used("batcher", T0), stores, primary };
    };
    const bulk = await run(true);
    const single = await run(false);
    expect(bulk.results).toEqual(single.results);
    expect(bulk.records).toEqual(single.records);
    expect(bulk.used).toBe(single.used);
    expect(bulk.used).toBe(9);
    expect(bulk.results.map((r) => r.provider)).toEqual([
      "batcher",
      "batcher",
      "backup",
      "batcher",
      "batcher",
      "batcher",
      "batcher",
      "batcher",
      "batcher",
      "batcher",
    ]);
    const { idempotency, dailyCaps } = bulk.stores;
    expect(idempotency.claimMany).toHaveBeenCalledTimes(1);
    expect(idempotency.claim).not.toHaveBeenCalled();
    expect(idempotency.touchMany).toHaveBeenCalledTimes(1);
    // Only the fallback attempt of c uses the single heartbeat.
    expect(idempotency.touch).toHaveBeenCalledTimes(1);
    expect(sizes(idempotency.finishMany)).toEqual([9, 1]);
    expect(idempotency.finish).not.toHaveBeenCalled();
    expect(sizes(dailyCaps.reserveMany)).toEqual([10]);
    expect(dailyCaps.reserve).not.toHaveBeenCalled();
    expect(sizes(dailyCaps.releaseMany)).toEqual([1]);
    expect(dailyCaps.release).not.toHaveBeenCalled();
  });

  it("gives a repeated key in_flight for the same payload and conflict for another payload", async () => {
    const stores = bulkStores();
    const primary = batchProvider();
    const m = capped([primary.adapter], { idempotency: stores.idempotency });
    const results = await m.sendBatch([
      message("a@x.org", { idempotencyKey: "dup" }),
      message("b@x.org", { idempotencyKey: "other" }),
      message("a@x.org", { idempotencyKey: "dup" }),
      message("z@x.org", { idempotencyKey: "dup" }),
    ]);
    expect(results.map((r) => [r.status, r.status === "unknown" ? r.reason : r.provider])).toEqual([
      ["sent", "batcher"],
      ["sent", "batcher"],
      ["unknown", "in_flight"],
      ["unknown", "idempotency_conflict"],
    ]);
    expect(sizes(stores.idempotency.claimMany)).toEqual([2]);
    expect(stores.idempotency.claim).toHaveBeenCalledTimes(2);
    expect(primary.batches[0]?.map((x) => x.to[0])).toEqual(["a@x.org", "b@x.org"]);
  });

  it("gives a later copy the stored result or a new claim when the first claim did not hold", async () => {
    const stores = bulkStores();
    const primary = batchProvider();
    const m = capped([primary.adapter], { idempotency: stores.idempotency });
    await m.sendBatch([message("a@x.org", { idempotencyKey: "done" })]);
    stores.idempotency.claimMany.mockRejectedValueOnce(new Error("D1 down"));
    const results = await m.sendBatch([
      message("b@x.org", { idempotencyKey: "fresh" }),
      message("b@x.org", { idempotencyKey: "fresh" }),
    ]);
    // The bulk claim failed, so the copy claims on the per-message path and sends.
    expect(results.map((r) => r.status)).toEqual(["not_sent", "sent"]);
    expect(results[0]).toMatchObject({ reason: "store_error" });
    const again = await m.sendBatch([
      message("a@x.org", { idempotencyKey: "done" }),
      message("a@x.org", { idempotencyKey: "done" }),
    ]);
    expect(again.map((r) => r.status === "sent" && r.providerMessageId)).toEqual([
      "batcher-a@x.org",
      "batcher-a@x.org",
    ]);
    expect(primary.batches.map((b) => b.length)).toEqual([1, 1]);
  });

  it("lets the second copy claim and send when the first copy fails validation", async () => {
    const stores = bulkStores();
    const primary = batchProvider();
    const m = capped([primary.adapter], { idempotency: stores.idempotency });
    const results = await m.sendBatch([
      message("bad", { idempotencyKey: "k" }),
      message("a@x.org", { idempotencyKey: "k" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["not_sent", "sent"]);
    expect(results[0]).toMatchObject({ reason: "invalid_message" });
    expect(sizes(stores.idempotency.claimMany)).toEqual([1]);
    expect(stores.idempotency.claim).not.toHaveBeenCalled();
    expect((await stores.memory.get(`${NAMESPACE}:k`))?.state).toBe("sent");
  });

  it("fails only the store chunk whose claimMany throws", async () => {
    const stores = bulkStores();
    const primary = batchProvider({ batchSize: 200 });
    const m = capped([primary.adapter], { idempotency: stores.idempotency });
    stores.idempotency.claimMany.mockRejectedValueOnce(new Error("D1 down"));
    const names = Array.from({ length: 150 }, (_, i) => `m${i}`);
    const results = await m.sendBatch(keyed(names));
    expect(results.slice(0, 100).every((r) => r.status === "not_sent")).toBe(true);
    expect(results[0]).toMatchObject({ reason: "store_error" });
    expect(results.slice(100).every((r) => r.status === "sent")).toBe(true);
    expect(primary.batches.map((b) => b.length)).toEqual([50]);
    expect(primary.batches[0]?.[0]?.to[0]).toBe("m100@x.org");
  });

  it("counts a claimMany list of the wrong length as a throw", async () => {
    const stores = bulkStores();
    const primary = batchProvider();
    const m = capped([primary.adapter], { idempotency: stores.idempotency });
    stores.idempotency.claimMany.mockResolvedValueOnce([{ kind: "claimed" }]);
    const results = await m.sendBatch(keyed(["a", "b"]));
    expect(results.map((r) => r.status === "not_sent" && r.reason)).toEqual([
      "store_error",
      "store_error",
    ]);
    expect(primary.batches).toHaveLength(0);
  });

  it("gives store_error only to the message whose claimMany outcome is malformed", async () => {
    const stores = bulkStores();
    const primary = batchProvider();
    const m = capped([primary.adapter], { idempotency: stores.idempotency });
    stores.idempotency.claimMany.mockImplementationOnce(async (inputs) => {
      const outcomes = await stores.memory.claimMany(inputs);
      return outcomes.map((outcome, i) => (i === 1 ? ({ status: "bogus" } as never) : outcome));
    });
    const results = await m.sendBatch(keyed(["a", "b", "c"]));
    expect(results.map((r) => (r.status === "not_sent" ? r.reason : r.status))).toEqual([
      "sent",
      "store_error",
      "sent",
    ]);
    expect(primary.batches.map((b) => b.map((x) => x.to[0]))).toEqual([["a@x.org", "c@x.org"]]);
  });

  it("gives store_error to the chunk whose touchMany throws and refunds its units", async () => {
    const stores = bulkStores();
    const primary = batchProvider({ batchSize: 2 });
    const m = capped([{ adapter: primary.adapter, dailyCap: 10 }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
    });
    stores.idempotency.touchMany.mockRejectedValueOnce(new Error("D1 down"));
    const results = await m.sendBatch(keyed(["a", "b", "c"]));
    expect(results.map((r) => (r.status === "not_sent" ? r.reason : r.status))).toEqual([
      "store_error",
      "store_error",
      "sent",
    ]);
    expect(primary.batches.map((b) => b.map((x) => x.to[0]))).toEqual([["c@x.org"]]);
    expect(await stores.caps.used("batcher", T0)).toBe(1);
    expect(sizes(stores.dailyCaps.releaseMany)).toEqual([2]);
    expect((await stores.memory.get(`${NAMESPACE}:k-a`))?.state).toBe("not_sent");
  });

  it("gives store_error to the chunk whose reserveMany throws and goes on with the next chunk", async () => {
    const stores = bulkStores();
    const primary = batchProvider({ batchSize: 200 });
    const m = capped([{ adapter: primary.adapter, dailyCap: 1000 }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
    });
    stores.dailyCaps.reserveMany.mockRejectedValueOnce(new Error("D1 down"));
    const results = await m.sendBatch(keyed(Array.from({ length: 120 }, (_, i) => `m${i}`)));
    expect(results.filter((r) => r.status === "not_sent")).toHaveLength(100);
    expect(results[99]).toMatchObject({ status: "not_sent", reason: "store_error" });
    expect(results.slice(100).every((r) => r.status === "sent")).toBe(true);
    expect(await stores.caps.used("batcher", T0)).toBe(20);
  });

  it("gives store_error to a granted item whose acquire throws and refunds its unit", async () => {
    const stores = bulkStores();
    const primary = batchProvider();
    let calls = 0;
    const rateLimits: RateLimitStore = {
      acquire: async () => {
        calls++;
        if (calls === 2) throw new Error("D1 down");
        return { ok: true };
      },
    };
    const m = capped([{ adapter: primary.adapter, dailyCap: 10, rate: { perSecond: 100 } }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
      rateLimits,
    });
    const results = await m.sendBatch(keyed(["a", "b", "c"]));
    expect(results.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(
      results.filter((r) => r.status === "not_sent" && r.reason === "store_error"),
    ).toHaveLength(1);
    expect(primary.batches[0]).toHaveLength(2);
    expect(await stores.caps.used("batcher", T0)).toBe(2);
    expect(sizes(stores.dailyCaps.releaseMany)).toEqual([1]);
  });

  it("refunds the unit of a rate refusal through releaseMany", async () => {
    const stores = bulkStores();
    const primary = batchProvider();
    let calls = 0;
    const rateLimits: RateLimitStore = {
      acquire: async () => {
        calls++;
        return calls === 3 ? { ok: false, retryAfterMs: 500 } : { ok: true };
      },
    };
    const m = capped([{ adapter: primary.adapter, dailyCap: 10, rate: { perSecond: 100 } }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
      rateLimits,
    });
    const results = await m.sendBatch(keyed(["a", "b", "c", "d"]));
    expect(results.filter((r) => r.status === "sent")).toHaveLength(3);
    expect(results.find((r) => r.status === "not_sent")).toMatchObject({
      reason: "rate_limited",
      retryAfterMs: 500,
    });
    expect(await stores.caps.used("batcher", T0)).toBe(3);
    expect(sizes(stores.dailyCaps.releaseMany)).toEqual([1]);
    expect(stores.dailyCaps.release).not.toHaveBeenCalled();
  });

  it("grants the last 3 units to the first 3 of 5 batch items", async () => {
    const stores = bulkStores();
    for (let i = 0; i < 7; i++) await stores.caps.reserve({ scope: "batcher", cap: 10, now: T0 });
    const primary = batchProvider();
    const m = capped([{ adapter: primary.adapter, dailyCap: 10 }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
    });
    const results = await m.sendBatch(keyed(["a", "b", "c", "d", "e"]));
    expect(primary.batches[0]?.map((x) => x.to[0])).toEqual(["a@x.org", "b@x.org", "c@x.org"]);
    expect(results.slice(3)).toEqual([
      expect.objectContaining({
        status: "not_sent",
        reason: "daily_cap",
        resetAt: bucketExpiry(T0),
      }),
      expect.objectContaining({
        status: "not_sent",
        reason: "daily_cap",
        resetAt: bucketExpiry(T0),
      }),
    ]);
    expect(await stores.caps.used("batcher", T0)).toBe(10);
  });

  it("drops an item whose touchMany result is false, refunds it, and sends the others", async () => {
    const stores = bulkStores();
    const warn = vi.fn();
    const primary = batchProvider();
    const m = capped([{ adapter: primary.adapter, dailyCap: 10 }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
      logger: { warn },
    });
    // Another request took over the claim of b before the heartbeat.
    stores.idempotency.touchMany.mockImplementationOnce((inputs) =>
      stores.memory.touchMany(
        inputs.map((input) =>
          input.key === `${NAMESPACE}:k-b` ? { ...input, claimId: "other" } : input,
        ),
      ),
    );
    const results = await m.sendBatch(keyed(["a", "b", "c"]));
    expect(results[1]).toMatchObject({ status: "unknown", reason: "stale_pending" });
    expect(results.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(primary.batches[0]?.map((x) => x.to[0])).toEqual(["a@x.org", "c@x.org"]);
    expect(await stores.caps.used("batcher", T0)).toBe(2);
    expect(warn.mock.calls.filter((call) => call[0] === LOST)).toHaveLength(1);
    // The lost claim gets no final record.
    expect(stores.idempotency.finishMany.mock.calls[0]?.[0].map((i) => i.key)).toEqual([
      `${NAMESPACE}:k-a`,
      `${NAMESPACE}:k-c`,
    ]);
  });

  it("refunds not_sent results through releaseMany and fills the window on quota", async () => {
    const stores = bulkStores();
    const primary = batchProvider({
      outcome: (to) =>
        (to === "a@x.org"
          ? NOT_SENT
          : to === "b@x.org"
            ? { status: "not_sent", reason: "quota", message: "Daily quota." }
            : undefined) as never,
    });
    const m = capped([{ adapter: primary.adapter, dailyCap: 10 }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
    });
    await m.sendBatch(keyed(["a", "b", "c"]));
    expect(sizes(stores.dailyCaps.releaseMany)).toEqual([2]);
    expect(stores.dailyCaps.fill).toHaveBeenCalledTimes(1);
    expect(await stores.caps.used("batcher", T0)).toBe(10);
  });

  it("keeps the results and still fills the window when releaseMany throws", async () => {
    const stores = bulkStores();
    const warn = vi.fn();
    const primary = batchProvider({
      outcome: (to) =>
        (to === "a@x.org"
          ? NOT_SENT
          : to === "b@x.org"
            ? { status: "not_sent", reason: "quota", message: "Daily quota." }
            : undefined) as never,
    });
    const m = capped([{ adapter: primary.adapter, dailyCap: 10 }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
      logger: { warn },
    });
    stores.dailyCaps.releaseMany.mockRejectedValueOnce(new Error("D1 down"));
    const results = await m.sendBatch(keyed(["a", "b", "c"]));
    expect(results.map((r) => (r.status === "not_sent" ? r.reason : r.status))).toEqual([
      "rejected",
      "quota",
      "sent",
    ]);
    expect(sizes(stores.dailyCaps.releaseMany)).toEqual([2]);
    const capWarnings = warn.mock.calls.filter(
      (call) => call[0] === "mailswitch: the daily cap store failed to refund or fill.",
    );
    expect(capWarnings).toHaveLength(1);
    // The fill runs after the failed refund.
    expect(stores.dailyCaps.fill).toHaveBeenCalledTimes(1);
    expect(await stores.caps.used("batcher", T0)).toBe(10);
  });

  it.each([
    [
      "throws",
      (stores: ReturnType<typeof bulkStores>) => {
        stores.idempotency.finishMany.mockRejectedValueOnce(new Error("D1 down"));
      },
    ],
    [
      "returns a list of the wrong length",
      (stores: ReturnType<typeof bulkStores>) => {
        stores.idempotency.finishMany.mockResolvedValueOnce([true]);
      },
    ],
  ])("keeps every sent result when finishMany %s", async (_, patch) => {
    const stores = bulkStores();
    const warn = vi.fn();
    const primary = batchProvider();
    const m = capped([primary.adapter], { idempotency: stores.idempotency, logger: { warn } });
    patch(stores);
    const results = await m.sendBatch(keyed(["a", "b"]));
    expect(results.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(stores.idempotency.finish).not.toHaveBeenCalled();
    // One warning per message. The records stay pending, so a retry cannot send twice.
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      "mailswitch: the store failed to write the final record.",
      "mailswitch: the store failed to write the final record.",
    ]);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ provider: "batcher", status: "sent" });
    for (const name of ["a", "b"]) {
      expect((await stores.memory.get(`${NAMESPACE}:k-${name}`))?.state).toBe("pending");
    }
  });

  it("sends a not_sent item through the fallback on the per-message path", async () => {
    const stores = bulkStores();
    const primary = batchProvider({
      outcome: (to) => (to === "b@x.org" ? NOT_SENT : undefined) as never,
    });
    const fallback = fakeProvider({ id: "backup" });
    const m = capped([primary.adapter, fallback], { idempotency: stores.idempotency });
    const results = await m.sendBatch(keyed(["a", "b", "c"]));
    expect(results.map((r) => r.provider)).toEqual(["batcher", "backup", "batcher"]);
    expect(stores.idempotency.touch).toHaveBeenCalledTimes(1);
    expect(
      stores.idempotency.finishMany.mock.calls.map((call) => call[0].map((i) => i.key)),
    ).toEqual([[`${NAMESPACE}:k-a`, `${NAMESPACE}:k-c`], [`${NAMESPACE}:k-b`]]);
    const record = await stores.memory.get(`${NAMESPACE}:k-b`);
    expect(record?.attempts.map((a) => [a.provider, a.status])).toEqual([
      ["batcher", "not_sent"],
      ["backup", "sent"],
    ]);
  });

  it("writes the records of sent messages before 12 messages fall back", async () => {
    const stores = bulkStores();
    const failing = (to: string) => Number(to.slice(1, to.indexOf("@"))) % 2 === 1;
    const primary = batchProvider({
      batchSize: 50,
      outcome: (to) => (failing(to) ? NOT_SENT : undefined) as never,
    });
    const fallback = fakeProvider({ id: "backup" });
    const m = capped([primary.adapter, fallback], { idempotency: stores.idempotency });
    // The store budget runs out after the first final record call, during the fallbacks.
    stores.idempotency.finishMany.mockImplementationOnce(async (inputs) => {
      stores.idempotency.touch.mockRejectedValue(new Error("too many queries"));
      stores.idempotency.finishMany.mockRejectedValue(new Error("too many queries"));
      return stores.memory.finishMany(inputs);
    });
    const names = Array.from({ length: 24 }, (_, i) => `m${i}`);
    const results = await m.sendBatch(keyed(names));
    expect(results.filter((r) => r.status === "sent")).toHaveLength(12);
    // The fallbacks stop at the failed heartbeat and keep the primary result.
    expect(fallback.sends).toHaveLength(0);
    expect(results.filter((r) => r.status === "not_sent" && r.reason === "rejected")).toHaveLength(
      12,
    );
    for (const [i, name] of names.entries()) {
      const record = await stores.memory.get(`${NAMESPACE}:k-${name}`);
      expect(record?.state).toBe(i % 2 === 1 ? "pending" : "sent");
    }
  });

  it("warns once per key when finishMany returns false and still returns the result", async () => {
    const stores = bulkStores();
    const warn = vi.fn();
    const primary = batchProvider();
    const m = capped([primary.adapter], { idempotency: stores.idempotency, logger: { warn } });
    stores.idempotency.finishMany.mockImplementationOnce((inputs) =>
      stores.memory.finishMany(
        inputs.map((input) =>
          input.key === `${NAMESPACE}:k-a` ? { ...input, claimId: "other" } : input,
        ),
      ),
    );
    const results = await m.sendBatch(keyed(["a", "b"]));
    expect(results.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(warn.mock.calls.filter((call) => call[0] === LOST)).toHaveLength(1);
    expect((await stores.memory.get(`${NAMESPACE}:k-a`))?.state).toBe("pending");
    expect((await stores.memory.get(`${NAMESPACE}:k-b`))?.state).toBe("sent");
  });

  it("keeps the per-message path for a subclass that overrides touch, and runs the override", async () => {
    class Tracking extends MemoryIdempotencyStore {
      touches = 0;
      override async touch(input: IdempotencyTouchInput): Promise<boolean> {
        this.touches++;
        return super.touch(input);
      }
    }
    const idempotency = new Tracking();
    expect(hasBulkIdempotency(idempotency)).toBe(false);
    const claimMany = vi.spyOn(MemoryIdempotencyStore.prototype, "claimMany");
    const touchMany = vi.spyOn(MemoryIdempotencyStore.prototype, "touchMany");
    try {
      const primary = batchProvider();
      const results = await capped([primary.adapter], { idempotency }).sendBatch(
        keyed(["a", "b", "c"]),
      );
      expect(results.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
      expect(idempotency.touches).toBe(3);
      expect(claimMany).not.toHaveBeenCalled();
      expect(touchMany).not.toHaveBeenCalled();
    } finally {
      claimMany.mockRestore();
      touchMany.mockRestore();
    }
  });

  it("uses bulk claims with a cap store that has no bulk methods", async () => {
    const stores = bulkStores();
    const dailyCaps = singleCaps(stores.caps);
    const reserve = vi.spyOn(dailyCaps, "reserve");
    const release = vi.spyOn(dailyCaps, "release");
    const primary = batchProvider({
      outcome: (to) => (to === "b@x.org" ? NOT_SENT : undefined) as never,
    });
    const m = capped([{ adapter: primary.adapter, dailyCap: 10 }], {
      idempotency: stores.idempotency,
      dailyCaps,
    });
    const results = await m.sendBatch(keyed(["a", "b", "c"]));
    expect(results.map((r) => r.status)).toEqual(["sent", "not_sent", "sent"]);
    expect(stores.idempotency.claimMany).toHaveBeenCalledTimes(1);
    expect(stores.idempotency.touchMany).toHaveBeenCalledTimes(1);
    expect(stores.idempotency.finishMany).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await stores.caps.used("batcher", T0)).toBe(2);
    expect((await stores.memory.get(`${NAMESPACE}:k-b`))?.state).toBe("not_sent");
  });

  it("uses bulk cap calls with an idempotency store that has no bulk methods", async () => {
    const stores = bulkStores();
    const idempotency = singleIdempotency(stores.memory);
    const claim = vi.spyOn(idempotency, "claim");
    const finish = vi.spyOn(idempotency, "finish");
    const primary = batchProvider({
      outcome: (to) => (to === "b@x.org" ? NOT_SENT : undefined) as never,
    });
    const m = capped([{ adapter: primary.adapter, dailyCap: 10 }], {
      idempotency,
      dailyCaps: stores.dailyCaps,
    });
    const results = await m.sendBatch(keyed(["a", "b", "c"]));
    expect(results.map((r) => r.status)).toEqual(["sent", "not_sent", "sent"]);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(finish).toHaveBeenCalledTimes(3);
    expect(sizes(stores.dailyCaps.reserveMany)).toEqual([3]);
    expect(sizes(stores.dailyCaps.releaseMany)).toEqual([1]);
    expect(stores.dailyCaps.reserve).not.toHaveBeenCalled();
    expect(await stores.caps.used("batcher", T0)).toBe(2);
    expect((await stores.memory.get(`${NAMESPACE}:k-c`))?.state).toBe("sent");
  });

  it("skips reserveMany when the primary has no cap", async () => {
    const stores = bulkStores();
    const primary = batchProvider();
    const m = capped([primary.adapter], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
    });
    const results = await m.sendBatch(keyed(["a", "b"]));
    expect(results.map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(stores.dailyCaps.reserveMany).not.toHaveBeenCalled();
    expect(stores.dailyCaps.reserve).not.toHaveBeenCalled();
  });

  it("makes 3 store calls for each bulk step with 250 items and a batch size of 500", async () => {
    const stores = bulkStores();
    const primary = batchProvider({ batchSize: 500 });
    const m = capped([{ adapter: primary.adapter, dailyCap: 1000 }], {
      idempotency: stores.idempotency,
      dailyCaps: stores.dailyCaps,
    });
    const names = Array.from({ length: 250 }, (_, i) => `m${i}`);
    const results = await m.sendBatch(keyed(names));
    expect(results.every((r) => r.status === "sent")).toBe(true);
    expect(primary.batches.map((b) => b.length)).toEqual([250]);
    for (const spy of [
      stores.idempotency.claimMany,
      stores.dailyCaps.reserveMany,
      stores.idempotency.touchMany,
      stores.idempotency.finishMany,
    ]) {
      expect(sizes(spy)).toEqual([100, 100, 50]);
    }
    expect(stores.dailyCaps.releaseMany).not.toHaveBeenCalled();
    // The claims and the cap units keep the input order.
    expect(stores.idempotency.claimMany.mock.calls[2]?.[0][0]?.key).toBe(`${NAMESPACE}:k-m200`);
  });
});
