import { describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../src/conformance/mock-fetch";
import { defineProvider, type ProviderAdapter } from "../../src/core/adapter";
import { defineProviderMeta } from "../../src/core/meta";
import { createMailer, type MailerOptions } from "../../src/core/pipeline";
import type { OutgoingMessage, SendResult } from "../../src/core/types";
import { resend } from "../../src/providers/resend/index";
import { MemoryDailyCapStore, MemoryIdempotencyStore } from "../../src/stores/memory";
import type { DailyCapStore, IdempotencyStore } from "../../src/stores/types";
import { type FakeOutcome, fakeMeta, fakeProvider } from "../../src/testing/fake-provider";
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

/** A batch provider. `outcome` maps a recipient to its batch result. */
function batchProvider(
  options: {
    id?: string;
    batchSize?: number;
    outcome?: (to: string) => SendResult | undefined;
  } = {},
) {
  const id = options.id ?? "batcher";
  const base = fakeMeta(id);
  const meta = defineProviderMeta({
    ...base,
    capabilities: { ...base.capabilities, batchSize: options.batchSize ?? 10 },
  });
  const batches: OutgoingMessage[][] = [];
  const singles: OutgoingMessage[] = [];
  const result = (m: OutgoingMessage): SendResult => {
    const to = m.to[0] as string;
    return options.outcome?.(to) ?? { status: "sent", providerMessageId: `${id}-${to}` };
  };
  const adapter: ProviderAdapter = defineProvider({
    meta,
    async send(m) {
      singles.push(m);
      return result(m);
    },
    async sendBatch(list) {
      batches.push([...list]);
      return list.map(result);
    },
    async verify() {
      return { ok: true };
    },
    webhooks: fakeProvider().webhooks,
  });
  return { adapter, batches, singles };
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
    const idempotency = new MemoryIdempotencyStore();
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

  for (const path of ["batch chunks", "single sends"] as const) {
    it(`keeps the later claims of a long call pending, not stale (${path})`, async () => {
      const clock = { now: T0 };
      const idempotency = new MemoryIdempotencyStore();
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
      expect((await idempotency.get(`${NAMESPACE}:k-f`))?.state).toBe("sent");
    });
  }
});

describe("sendBatch: store failures", () => {
  it("returns every result and warns when the final record fails to write", async () => {
    const warn = vi.fn();
    const idempotency = new MemoryIdempotencyStore();
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
    const idempotency = new MemoryIdempotencyStore();
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
    const dailyCaps = new MemoryDailyCapStore();
    const idempotency = new MemoryIdempotencyStore();
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
