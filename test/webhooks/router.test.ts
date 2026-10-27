import { describe, expect, it, vi } from "vitest";
import {
  MAILGUN_FIXTURE_SECRET,
  mailgunEvent,
  signMailgunWebhook,
} from "../../src/conformance/fixtures/mailgun";
import {
  RESEND_FIXTURE_SECRET,
  RESEND_FIXTURE_SVIX_ID,
  resendEvent,
  signResendWebhook,
} from "../../src/conformance/fixtures/resend";
import { toSendBounce, toSendComplaint } from "../../src/conformance/fixtures/tosend";
import type { ProviderAdapter } from "../../src/core/adapter";
import { utf8 } from "../../src/internal/encoding";
import { sha256Hex } from "../../src/internal/sha256";
import { mailgun } from "../../src/providers/mailgun/index";
import { resend } from "../../src/providers/resend/index";
import { tosend } from "../../src/providers/tosend/index";
import { toSendSignature } from "../../src/providers/tosend/webhooks";
import { MemoryDedupeStore } from "../../src/stores/memory";
import type { DedupeStore } from "../../src/stores/types";
import {
  type BodyBoundAdapter,
  DEFAULT_DEDUPE_TTL_MS,
  DEFAULT_LEASE_MS,
  handleWebhook,
  UNSIGNED_TIMESTAMP_TTL_MS,
  type WebhookAccepted,
} from "../../src/webhooks/index";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const TOSEND_SECRET = "tosend-webhook-secret-0123456789";
const URL = "https://app.test/webhooks/mail";

function post(body: BodyInit | null, headers: Headers): Request {
  return new Request(URL, { method: "POST", headers, body });
}

async function resendRequest(body: string, id?: string, at = NOW): Promise<Request> {
  const sample = await signResendWebhook({
    body: utf8(body),
    secret: RESEND_FIXTURE_SECRET,
    at,
    ...(id ? { id } : {}),
  });
  return post(sample.body, sample.headers);
}

async function toSendRequest(body: string, secret = TOSEND_SECRET): Promise<Request> {
  const bytes = utf8(body);
  return post(bytes, new Headers({ "x-tosend-signature": await toSendSignature(secret, bytes) }));
}

/** A memory store that records every call. */
function spyStore(): { store: DedupeStore; calls: string[] } {
  const inner = new MemoryDedupeStore();
  const calls: string[] = [];
  const store: DedupeStore = {
    claim: (input) => {
      calls.push(`claim ${input.key}`);
      return inner.claim(input);
    },
    commit: (input) => {
      calls.push(`commit ${input.key} ${input.ttlMs}`);
      return inner.commit(input);
    },
    release: (input) => {
      calls.push(`release ${input.key}`);
      return inner.release(input);
    },
    purgeExpired: (now) => inner.purgeExpired(now),
  };
  return { store, calls };
}

function accepted(outcome: Awaited<ReturnType<typeof handleWebhook>>): WebhookAccepted {
  if (!outcome.ok) throw new Error(`Refused: ${outcome.rejection}`);
  return outcome;
}

describe("handleWebhook with Resend", () => {
  it("gives the documented normalized event for a hard bounce", async () => {
    const { store } = spyStore();
    const request = await resendRequest(
      resendEvent("email.bounced", { bounce: { type: "Permanent", subType: "General" } }),
    );
    const outcome = accepted(
      await handleWebhook(request, {
        adapter: resend(),
        secret: RESEND_FIXTURE_SECRET,
        dedupe: store,
        now: () => NOW,
      }),
    );
    expect(outcome.events).toEqual([
      {
        type: "bounced",
        bounce: "hard",
        recipient: "ana@example.org",
        providerMessageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
        occurredAt: Date.parse("2026-10-26T12:00:00.000Z"),
        provider: "resend",
        eventKey: RESEND_FIXTURE_SVIX_ID,
        rawType: "email.bounced",
      },
    ]);
  });

  it("works with no dedupe store for a provider that signs a timestamp", async () => {
    const request = await resendRequest(resendEvent("email.delivered"));
    const outcome = accepted(
      await handleWebhook(request, {
        adapter: resend(),
        secret: RESEND_FIXTURE_SECRET,
        now: () => NOW,
      }),
    );
    expect(outcome.events.map((event) => event.type)).toEqual(["delivered"]);
    await outcome.ack();
  });

  it("returns an unknown event type as unknown", async () => {
    const outcome = accepted(
      await handleWebhook(await resendRequest(resendEvent("email.opened")), {
        adapter: resend(),
        secret: RESEND_FIXTURE_SECRET,
        dedupe: new MemoryDedupeStore(),
        now: () => NOW,
      }),
    );
    expect(outcome.events).toEqual([
      expect.objectContaining({ type: "unknown", rawType: "email.opened" }),
    ]);
  });

  it("refuses a stale signature with 401", async () => {
    const request = await resendRequest(resendEvent("email.delivered"), undefined, NOW - 600_000);
    const outcome = await handleWebhook(request, {
      adapter: resend(),
      secret: RESEND_FIXTURE_SECRET,
      dedupe: new MemoryDedupeStore(),
      now: () => NOW,
    });
    expect(outcome).toEqual({ ok: false, rejection: "stale", status: 401 });
  });

  it("commits with the 7-day TTL", async () => {
    const { store, calls } = spyStore();
    const outcome = accepted(
      await handleWebhook(await resendRequest(resendEvent("email.delivered")), {
        adapter: resend(),
        secret: RESEND_FIXTURE_SECRET,
        dedupe: store,
        endpointId: "eu",
        now: () => NOW,
      }),
    );
    await outcome.ack();
    expect(calls).toEqual([
      `claim resend:eu:${RESEND_FIXTURE_SVIX_ID}`,
      `commit resend:eu:${RESEND_FIXTURE_SVIX_ID} ${DEFAULT_DEDUPE_TTL_MS}`,
    ]);
  });
});

describe("handleWebhook with toSend", () => {
  it("gives the documented normalized events for a bounce and a complaint", async () => {
    const dedupe = new MemoryDedupeStore();
    const options = { adapter: tosend(), secret: TOSEND_SECRET, dedupe, now: () => NOW };
    const bounce = accepted(
      await handleWebhook(await toSendRequest(toSendBounce("ana@example.org")), options),
    );
    expect(bounce.events).toEqual([
      expect.objectContaining({
        type: "bounced",
        bounce: "hard",
        recipient: "ana@example.org",
        providerMessageId: "0100019a-tosend-1",
        provider: "tosend",
        rawType: "bounced",
        occurredAt: Date.parse("2026-10-26T11:59:58.000Z"),
      }),
    ]);
    const complaint = accepted(
      await handleWebhook(await toSendRequest(toSendComplaint("ana@example.org")), options),
    );
    expect(complaint.events).toEqual([
      expect.objectContaining({ type: "complained", rawType: "complaint" }),
    ]);
  });

  it("gives two events for two recipients in one body", async () => {
    const body = `[${toSendBounce("ana@example.org")},${toSendBounce("bo@example.org")}]`;
    const outcome = accepted(
      await handleWebhook(await toSendRequest(body), {
        adapter: tosend(),
        secret: TOSEND_SECRET,
        dedupe: new MemoryDedupeStore(),
        now: () => NOW,
      }),
    );
    expect(outcome.events.map((event) => event.recipient)).toEqual([
      "ana@example.org",
      "bo@example.org",
    ]);
  });

  it("commits with the 30-day TTL, because toSend signs no timestamp", async () => {
    const { store, calls } = spyStore();
    const outcome = accepted(
      await handleWebhook(await toSendRequest(toSendBounce("ana@example.org")), {
        adapter: tosend(),
        secret: TOSEND_SECRET,
        dedupe: store,
        now: () => NOW,
      }),
    );
    await outcome.ack();
    expect(calls[1]).toMatch(
      new RegExp(`^commit tosend:default:[0-9a-f]{64} ${UNSIGNED_TIMESTAMP_TTL_MS}$`),
    );
  });

  it("throws without a dedupe store, and the types refuse it", async () => {
    const request = await toSendRequest(toSendBounce("ana@example.org"));
    expect(() =>
      // @ts-expect-error toSend needs a dedupe store.
      handleWebhook(request, { adapter: tosend(), secret: TOSEND_SECRET }),
    ).toThrow(/needs a dedupe store/);
    expect(request.bodyUsed).toBe(false);
  });
});

describe("handleWebhook refusals", () => {
  it("refuses a bad signature with no events and no store write", async () => {
    const { store, calls } = spyStore();
    const outcome = await handleWebhook(
      await toSendRequest(toSendBounce("ana@example.org"), "wrong-secret"),
      { adapter: tosend(), secret: TOSEND_SECRET, dedupe: store, now: () => NOW },
    );
    expect(outcome).toEqual({ ok: false, rejection: "bad_signature", status: 401 });
    expect(calls).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain("sha256=");
  });

  it("refuses a malformed secret as invalid_secret with 500, without a throw", async () => {
    const outcome = await handleWebhook(await resendRequest(resendEvent("email.bounced")), {
      adapter: resend(),
      secret: "whsec_%%%%",
      now: () => NOW,
    });
    expect(outcome).toEqual({ ok: false, rejection: "invalid_secret", status: 500 });
  });

  it("refuses a used body", async () => {
    const request = await toSendRequest(toSendBounce("ana@example.org"));
    await request.text();
    const outcome = await handleWebhook(request, {
      adapter: tosend(),
      secret: TOSEND_SECRET,
      dedupe: new MemoryDedupeStore(),
    });
    expect(outcome).toEqual({ ok: false, rejection: "body_used", status: 500 });
  });

  it("refuses a 2 MB body as too_large without calling verify", async () => {
    const base = tosend();
    const verify = vi.fn(base.webhooks.verify);
    const adapter = { ...base, webhooks: { ...base.webhooks, verify } };
    const big = new Uint8Array(2 * 1024 * 1024).fill(0x20);
    const withLength = await handleWebhook(
      post(big, new Headers({ "content-length": String(big.length) })),
      { adapter, secret: TOSEND_SECRET, dedupe: new MemoryDedupeStore() },
    );
    expect(withLength).toEqual({ ok: false, rejection: "too_large", status: 413 });

    // A streamed body has no Content-Length. The read stops at the cap.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 32; i++) controller.enqueue(new Uint8Array(64 * 1024));
        controller.close();
      },
    });
    const streamed = await handleWebhook(
      new Request(URL, { method: "POST", body: stream, duplex: "half" } as RequestInit),
      { adapter, secret: TOSEND_SECRET, dedupe: new MemoryDedupeStore() },
    );
    expect(streamed).toEqual({ ok: false, rejection: "too_large", status: 413 });
    expect(verify).not.toHaveBeenCalled();
  });

  it("throws for an adapter with no webhooks and for a bad option", () => {
    const request = post("{}", new Headers());
    const plain = { ...resend(), webhooks: undefined } as ProviderAdapter;
    expect(() => handleWebhook(request, { adapter: plain, secret: "s" })).toThrow(TypeError);
    expect(() => handleWebhook(request, { adapter: resend(), secret: "s", leaseMs: 0 })).toThrow(
      /leaseMs/,
    );
  });
});

describe("handleWebhook dedupe", () => {
  const options = (dedupe: DedupeStore, clock: { t: number }) => ({
    adapter: tosend(),
    secret: TOSEND_SECRET,
    dedupe,
    now: () => clock.t,
  });

  it("gives the same event once after ack()", async () => {
    const dedupe = new MemoryDedupeStore();
    const clock = { t: NOW };
    const body = toSendBounce("ana@example.org");
    const first = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    expect(first.events).toHaveLength(1);
    await first.ack();
    clock.t += DEFAULT_LEASE_MS * 10;
    const second = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    expect(second.events).toEqual([]);
  });

  it("delivers again after the lease expires with no ack()", async () => {
    const dedupe = new MemoryDedupeStore();
    const clock = { t: NOW };
    const body = toSendBounce("ana@example.org");
    const first = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    expect(first.events).toHaveLength(1);
    clock.t += DEFAULT_LEASE_MS;
    const retry = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    expect(retry.events).toHaveLength(1);
  });

  it("keeps a newer request's lease when a stale request releases or acks late", async () => {
    const dedupe = new MemoryDedupeStore();
    const clock = { t: NOW };
    const body = toSendBounce("ana@example.org");
    const stale = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    clock.t += DEFAULT_LEASE_MS + 1;
    const newer = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    expect(newer.events).toHaveLength(1);
    await stale.release();
    const third = await handleWebhook(await toSendRequest(body), options(dedupe, clock));
    expect(third).toMatchObject({ ok: false, rejection: "in_flight" });
    await stale.ack();
    await newer.release();
    const fourth = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    expect(fourth.events).toHaveLength(1);
  });

  it("refuses a retry during the lease as in_flight with 409", async () => {
    const dedupe = new MemoryDedupeStore();
    const clock = { t: NOW };
    const body = toSendBounce("ana@example.org");
    accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    clock.t += 1000;
    const retry = await handleWebhook(await toSendRequest(body), options(dedupe, clock));
    expect(retry).toEqual({ ok: false, rejection: "in_flight", status: 409 });
  });

  it("releases the keys it claimed when another key is in flight", async () => {
    const dedupe = new MemoryDedupeStore();
    const clock = { t: NOW };
    const bo = toSendBounce("bo@example.org");
    accepted(await handleWebhook(await toSendRequest(bo), options(dedupe, clock)));
    // A body whose first key is free and whose second key is held by the request above.
    const adapter = tosend();
    const parse = adapter.webhooks.parse;
    const mixed = {
      ...adapter,
      webhooks: {
        ...adapter.webhooks,
        parse: (raw: Uint8Array, headers: Headers) => {
          const [event] = parse(raw, headers);
          const [held] = parse(utf8(bo), headers);
          return event && held ? [event, held] : [];
        },
      },
    };
    const body = toSendBounce("ana@example.org");
    const refused = await handleWebhook(await toSendRequest(body), {
      ...options(dedupe, clock),
      adapter: mixed,
    });
    expect(refused).toMatchObject({ ok: false, rejection: "in_flight" });
    const again = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    expect(again.events).toHaveLength(1);
  });

  it("frees the keys on release()", async () => {
    const dedupe = new MemoryDedupeStore();
    const clock = { t: NOW };
    const body = toSendBounce("ana@example.org");
    const first = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    await first.release();
    const retry = accepted(await handleWebhook(await toSendRequest(body), options(dedupe, clock)));
    expect(retry.events).toHaveLength(1);
  });

  it("keeps the keys of two endpoints apart", async () => {
    const dedupe = new MemoryDedupeStore();
    const clock = { t: NOW };
    const body = toSendBounce("ana@example.org");
    const a = accepted(
      await handleWebhook(await toSendRequest(body), {
        ...options(dedupe, clock),
        endpointId: "a",
      }),
    );
    await a.ack();
    const b = accepted(
      await handleWebhook(await toSendRequest(body), {
        ...options(dedupe, clock),
        endpointId: "b",
      }),
    );
    expect(b.events).toHaveLength(1);
  });
});

/** A memory store with the bulk methods that records each call. */
function bulkSpyStore(): {
  store: Required<DedupeStore>;
  inner: MemoryDedupeStore;
  calls: { method: string; keys: string[] }[];
} {
  const inner = new MemoryDedupeStore();
  const calls: { method: string; keys: string[] }[] = [];
  const record = (method: string, keys: readonly string[]) => {
    calls.push({ method, keys: [...keys] });
  };
  const store: Required<DedupeStore> = {
    claim: (input) => {
      record("claim", [input.key]);
      return inner.claim(input);
    },
    commit: (input) => {
      record("commit", [input.key]);
      return inner.commit(input);
    },
    release: (input) => {
      record("release", [input.key]);
      return inner.release(input);
    },
    claimMany: (input) => {
      record("claimMany", input.keys);
      return inner.claimMany(input);
    },
    commitMany: (input) => {
      record(
        "commitMany",
        input.leases.map((lease) => lease.key),
      );
      return inner.commitMany(input);
    },
    releaseMany: (leases) => {
      record(
        "releaseMany",
        leases.map((lease) => lease.key),
      );
      return inner.releaseMany(leases);
    },
    purgeExpired: (now) => inner.purgeExpired(now),
  };
  return { store, inner, calls };
}

/** A memory store with the single methods only, so the router uses its loop. */
function loopStore(inner: MemoryDedupeStore): DedupeStore {
  return {
    claim: (input) => inner.claim(input),
    commit: (input) => inner.commit(input),
    release: (input) => inner.release(input),
    purgeExpired: (now) => inner.purgeExpired(now),
  };
}

/** A toSend body with `count` distinct events. */
function toSendBody(count: number, from = 0): string {
  const items = Array.from({ length: count }, (_, i) =>
    toSendBounce(`r${from + i}@example.org`, true, `msg-${from + i}`),
  );
  return `[${items.join(",")}]`;
}

/**
 * The toSend adapter with the recipient as the event key. toSend keys hold the body
 * hash, so this adapter lets two bodies share a key and one body repeat a key.
 */
function recipientKeyed() {
  const base = tosend();
  const parse = base.webhooks.parse;
  return {
    ...base,
    webhooks: {
      ...base.webhooks,
      parse: (raw: Uint8Array, headers: Headers) =>
        parse(raw, headers).map((event) => ({ ...event, eventKey: event.recipient ?? "" })),
    },
  };
}

/** The dedupe keys of a body for `recipientKeyed`, in body order. */
async function toSendKeys(body: string): Promise<string[]> {
  return recipientKeyed()
    .webhooks.parse(utf8(body), new Headers())
    .map((event) => `tosend:default:${event.eventKey}`);
}

/**
 * A body-bound adapter for tests. It accepts any signature, and its body is a JSON array
 * of event keys.
 */
function syntheticBodyBound(): BodyBoundAdapter {
  const base = tosend();
  return {
    ...base,
    meta: { ...base.meta, id: "syn" },
    requiresDedupe: true,
    bodyBoundKeys: true,
    webhooks: {
      ...base.webhooks,
      verify: async () => ({ ok: true }),
      parse: (raw: Uint8Array) =>
        (JSON.parse(new TextDecoder().decode(raw)) as string[]).map((eventKey) => ({
          type: "unknown" as const,
          provider: "syn",
          eventKey,
          rawType: "test",
        })),
    },
  };
}

describe("handleWebhook with a bulk dedupe store", () => {
  const options = (dedupe: DedupeStore, clock = { t: NOW }) => ({
    adapter: recipientKeyed(),
    secret: TOSEND_SECRET,
    dedupe,
    now: () => clock.t,
  });

  it("claims the keys of 3 events in one claimMany call and commits them in one call", async () => {
    const { store, calls } = bulkSpyStore();
    const body = toSendBody(3);
    const outcome = accepted(await handleWebhook(await toSendRequest(body), options(store)));
    expect(outcome.events).toHaveLength(3);
    expect(calls).toEqual([{ method: "claimMany", keys: await toSendKeys(body) }]);
    await outcome.ack();
    expect(calls.map((call) => call.method)).toEqual(["claimMany", "commitMany"]);
    expect(calls[1]?.keys).toHaveLength(3);
  });

  it("gives 0 events for the same body after ack()", async () => {
    const { store } = bulkSpyStore();
    const body = toSendBody(3);
    await accepted(await handleWebhook(await toSendRequest(body), options(store))).ack();
    const again = await handleWebhook(await toSendRequest(body), options(store));
    expect(accepted(again).events).toEqual([]);
  });

  it("gives a repeated event once and claims distinct keys", async () => {
    const { store, calls } = bulkSpyStore();
    const one = toSendBounce("ana@example.org");
    const outcome = accepted(
      await handleWebhook(await toSendRequest(`[${one},${one}]`), options(store)),
    );
    expect(outcome.events).toHaveLength(1);
    expect(calls[0]?.keys).toHaveLength(1);
  });

  it("refuses a retry during the lease as in_flight and releases every lease of the retry", async () => {
    const { store, inner, calls } = bulkSpyStore();
    accepted(await handleWebhook(await toSendRequest(toSendBody(1)), options(store)));
    const retryBody = toSendBody(3);
    const retry = await handleWebhook(await toSendRequest(retryBody), options(store));
    expect(retry).toEqual({ ok: false, rejection: "in_flight", status: 409 });
    const [, fresh1, fresh2] = await toSendKeys(retryBody);
    expect(calls.at(-1)).toEqual({ method: "releaseMany", keys: [fresh1, fresh2] });
    const free = await inner.claimMany({
      keys: [fresh1 as string, fresh2 as string],
      leaseMs: DEFAULT_LEASE_MS,
      now: NOW,
    });
    expect(free.map((outcome) => outcome.status)).toEqual(["new", "new"]);
  });

  it("lets one of two parallel bodies with a shared key win, and releases the other's keys", async () => {
    const { store, inner } = bulkSpyStore();
    const a = toSendBody(2, 0);
    const b = toSendBody(2, 1);
    const [first, second] = await Promise.all([
      handleWebhook(await toSendRequest(a), options(store)),
      handleWebhook(await toSendRequest(b), options(store)),
    ]);
    const outcomes = [first, second];
    const winner = outcomes.findIndex((outcome) => outcome?.ok);
    expect(winner).not.toBe(-1);
    const loser = outcomes[1 - winner];
    expect(loser).toEqual({ ok: false, rejection: "in_flight", status: 409 });
    // The key that only the loser had is free again.
    const loserKeys = await toSendKeys(winner === 0 ? b : a);
    const winnerKeys = await toSendKeys(winner === 0 ? a : b);
    const onlyLoser = loserKeys.filter((key) => !winnerKeys.includes(key));
    expect(onlyLoser).toHaveLength(1);
    const free = await inner.claim({ key: onlyLoser[0] as string, leaseMs: 1, now: NOW });
    expect(free.status).toBe("new");
  });

  it("refuses a Mailgun token reused with another body as bad_signature", async () => {
    const { store, calls } = bulkSpyStore();
    const mailgunOptions = {
      adapter: mailgun(),
      secret: MAILGUN_FIXTURE_SECRET,
      dedupe: store,
      now: () => NOW,
    };
    const signedMailgun = async (data: string) => {
      const sample = await signMailgunWebhook({
        body: utf8(data),
        secret: MAILGUN_FIXTURE_SECRET,
        at: NOW,
        token: "a".repeat(50),
      });
      return post(sample.body, sample.headers);
    };
    const bounce = mailgunEvent("failed", { severity: "permanent", reason: "bounce" });
    const first = accepted(await handleWebhook(await signedMailgun(bounce), mailgunOptions));
    expect(first.events).toHaveLength(1);
    expect(calls[0]?.keys).toHaveLength(2);
    const other = mailgunEvent("delivered", {}, "eve@example.org");
    expect(await handleWebhook(await signedMailgun(other), mailgunOptions)).toEqual({
      ok: false,
      rejection: "bad_signature",
      status: 401,
    });
    expect(calls.every((call) => call.method !== "claim")).toBe(true);
  });

  it("gives the same result as the loop for every primary and bound key state", async () => {
    type State = "free" | "held" | "done";
    const states: State[] = ["free", "held", "done"];
    const body = JSON.stringify(["e0", "e1", "e2"]);
    const fingerprint = sha256Hex(utf8(body));
    const put = async (inner: MemoryDedupeStore, key: string, state: State) => {
      if (state === "free") return;
      const claim = await inner.claim({ key, leaseMs: DEFAULT_LEASE_MS, now: NOW - 1 });
      if (state === "done" && claim.status === "new") {
        await inner.commit({ key, leaseId: claim.leaseId, ttlMs: DEFAULT_DEDUPE_TTL_MS, now: NOW });
      }
    };
    const run = async (bulk: boolean, combo: State[]) => {
      const inner = new MemoryDedupeStore();
      for (const [i, event] of ["e1", "e2"].entries()) {
        await put(inner, `syn:default:${event}`, combo[i * 2] as State);
        await put(inner, `syn:default:${event}#${fingerprint}`, combo[i * 2 + 1] as State);
      }
      const dedupe = bulk ? inner : loopStore(inner);
      const outcome = await handleWebhook(post(body, new Headers()), {
        adapter: syntheticBodyBound(),
        secret: "s",
        dedupe,
        ttlMs: DEFAULT_DEDUPE_TTL_MS,
        now: () => NOW,
      });
      const view = outcome.ok
        ? { ok: true, keys: outcome.events.map((event) => event.eventKey) }
        : outcome;
      if (outcome.ok) await outcome.ack();
      // The state of each key after the request shows the same releases and commits.
      const after: string[] = [];
      for (const event of ["e0", "e1", "e2"]) {
        for (const key of [`syn:default:${event}`, `syn:default:${event}#${fingerprint}`]) {
          after.push((await inner.claim({ key, leaseMs: 1, now: NOW + 1 })).status);
        }
      }
      return { view, after };
    };
    for (const a of states) {
      for (const b of states) {
        for (const c of states) {
          for (const d of states) {
            const combo = [a, b, c, d];
            expect(await run(true, combo), combo.join(",")).toEqual(await run(false, combo));
          }
        }
      }
    }
  });

  it("puts both keys of a body-bound event in the same chunk", async () => {
    const { store, calls } = bulkSpyStore();
    const keys = Array.from({ length: 300 }, (_, i) => `e${i}`);
    const outcome = await handleWebhook(post(JSON.stringify(keys), new Headers()), {
      adapter: syntheticBodyBound(),
      secret: "s",
      dedupe: store,
      now: () => NOW,
    });
    expect(accepted(outcome).events).toHaveLength(300);
    expect(calls.map((call) => call.keys.length)).toEqual([500, 100]);
    expect(calls[0]?.keys.at(-2)).toBe("syn:default:e249");
    expect(calls[0]?.keys.at(-1)).toMatch(/^syn:default:e249#[0-9a-f]{64}$/);
  });

  it("releases the leases of the first chunk when the second claimMany throws", async () => {
    const { store, inner, calls } = bulkSpyStore();
    let claims = 0;
    const failing: DedupeStore = {
      ...store,
      claimMany: (input) => {
        claims++;
        if (claims === 2) return Promise.reject(new Error("store down"));
        return store.claimMany(input);
      },
    };
    const body = toSendBody(600);
    await expect(handleWebhook(await toSendRequest(body), options(failing))).rejects.toThrow(
      "store down",
    );
    const keys = await toSendKeys(body);
    expect(calls.at(-1)).toEqual({ method: "releaseMany", keys: keys.slice(0, 500) });
    const again = await inner.claimMany({ keys, leaseMs: 1, now: NOW });
    expect(again.every((outcome) => outcome.status === "new")).toBe(true);
  });

  it("uses the loop for a store with only claimMany", async () => {
    const { store, calls } = bulkSpyStore();
    const partial: DedupeStore = {
      claim: store.claim,
      commit: store.commit,
      release: store.release,
      purgeExpired: store.purgeExpired,
      claimMany: store.claimMany,
    };
    const outcome = accepted(
      await handleWebhook(await toSendRequest(toSendBody(2)), options(partial)),
    );
    await outcome.ack();
    expect(calls.map((call) => call.method)).toEqual(["claim", "claim", "commit", "commit"]);
  });

  it("claims a body with 1,200 events in 3 chunks", async () => {
    const { store, calls } = bulkSpyStore();
    const outcome = accepted(
      await handleWebhook(await toSendRequest(toSendBody(1200)), options(store)),
    );
    expect(outcome.events).toHaveLength(1200);
    await outcome.ack();
    expect(calls.map((call) => [call.method, call.keys.length])).toEqual([
      ["claimMany", 500],
      ["claimMany", 500],
      ["claimMany", 200],
      ["commitMany", 500],
      ["commitMany", 500],
      ["commitMany", 200],
    ]);
  });

  it("releases every lease in chunks on release()", async () => {
    const { store, inner, calls } = bulkSpyStore();
    const body = toSendBody(600);
    const outcome = accepted(await handleWebhook(await toSendRequest(body), options(store)));
    await outcome.release();
    expect(calls.slice(2).map((call) => [call.method, call.keys.length])).toEqual([
      ["releaseMany", 500],
      ["releaseMany", 100],
    ]);
    const again = await inner.claimMany({ keys: await toSendKeys(body), leaseMs: 1, now: NOW });
    expect(again.every((outcome) => outcome.status === "new")).toBe(true);
  });
});
