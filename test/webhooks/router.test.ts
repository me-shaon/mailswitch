import { describe, expect, it, vi } from "vitest";
import {
  RESEND_FIXTURE_SECRET,
  RESEND_FIXTURE_SVIX_ID,
  resendEvent,
  signResendWebhook,
} from "../../src/conformance/fixtures/resend";
import { toSendBounce, toSendComplaint } from "../../src/conformance/fixtures/tosend";
import type { ProviderAdapter } from "../../src/core/adapter";
import { utf8 } from "../../src/internal/encoding";
import { resend } from "../../src/providers/resend/index";
import { tosend } from "../../src/providers/tosend/index";
import { toSendSignature } from "../../src/providers/tosend/webhooks";
import { MemoryDedupeStore } from "../../src/stores/memory";
import type { DedupeStore } from "../../src/stores/types";
import {
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
