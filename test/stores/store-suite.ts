import { describe, expect, it } from "vitest";
import {
  beginIdempotency,
  finalizeIdempotency,
  NOT_SENT_RETENTION_MS,
  SENT_RETENTION_MS,
} from "../../src/core/idempotency";
import type { OutgoingMessage, SendResult } from "../../src/core/types";
import type { IdempotencyAttempt, IdempotencyStore } from "../../src/stores/types";

/** What the suite needs from one store implementation. */
export interface StoreHarness {
  store: IdempotencyStore;
  /** The stored row exactly as the backend holds it. */
  rawRow(key: string): Promise<unknown>;
}

const NAMESPACE = "app";
const TIMEOUT = 60_000;
const T0 = 1_800_000_000_000;
const RECIPIENT = "ana.private@example.com";
const API_KEY = "re_live_DO_NOT_STORE_123456";

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: "Acme <billing@acme.test>",
    to: [RECIPIENT],
    subject: "Invoice 42",
    text: "Your invoice is attached.",
    attachments: [
      {
        filename: "invoice.pdf",
        contentType: "application/pdf",
        content: new Uint8Array([1, 2, 3]),
      },
    ],
    idempotencyKey: "invoice-42",
    ...overrides,
  };
}

interface Network {
  calls: number;
  /** The status that the next fake send returns. */
  status: IdempotencyAttempt["status"];
}

/** A send through the guard. The network call is a counter. */
async function send(
  store: IdempotencyStore,
  msg: OutgoingMessage,
  now: number,
  network: Network,
): Promise<SendResult> {
  const begin = await beginIdempotency(store, NAMESPACE, msg, { now, pendingTimeoutMs: TIMEOUT });
  if (!begin.proceed) return begin.result;
  network.calls++;
  const status = network.status;
  const attempts: IdempotencyAttempt[] =
    status === "sent"
      ? [{ provider: "fake", status, at: now }]
      : [{ provider: "fake", status, reason: status === "unknown" ? "timeout" : "auth", at: now }];
  await finalizeIdempotency(store, {
    key: begin.key,
    claimId: begin.claimId,
    attempts,
    providerMessageId: "msg_1",
    now,
  });
  return status === "sent"
    ? { status, providerMessageId: "msg_1", provider: "fake" }
    : { status, reason: "timeout", message: "fake" };
}

const KEY = `${NAMESPACE}:invoice-42`;

/** The shared suite. Every `IdempotencyStore` implementation must pass it. */
export function idempotencyStoreSuite(name: string, setup: () => Promise<StoreHarness>): void {
  describe(`${name} idempotency store`, () => {
    it("returns the stored result for a repeat, with no network call", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      const first = await send(store, message(), T0, network);
      const second = await send(store, message(), T0 + 1000, network);
      expect(first).toEqual({ status: "sent", providerMessageId: "msg_1", provider: "fake" });
      expect(second).toEqual(first);
      expect(network.calls).toBe(1);
      const record = await store.get(KEY);
      expect(record?.state).toBe("sent");
      expect(record?.expiresAt).toBe(T0 + SENT_RETENTION_MS);
    });

    it("gives exactly one claim to parallel sends with one key", async () => {
      const { store } = await setup();
      const begins = await Promise.all(
        Array.from({ length: 5 }, () =>
          beginIdempotency(store, NAMESPACE, message(), { now: T0, pendingTimeoutMs: TIMEOUT }),
        ),
      );
      expect(begins.filter((begin) => begin.proceed)).toHaveLength(1);
      for (const begin of begins) {
        if (!begin.proceed) {
          expect(begin.result).toMatchObject({ status: "unknown", reason: "in_flight" });
        }
      }
    });

    it("returns unknown/idempotency_conflict for a different payload", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      await send(store, message(), T0, network);
      const result = await send(store, message({ subject: "Invoice 43" }), T0 + 1, network);
      expect(result).toMatchObject({ status: "unknown", reason: "idempotency_conflict" });
      expect(network.calls).toBe(1);
    });

    it("returns unknown/in_flight while the claim is pending", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      await beginIdempotency(store, NAMESPACE, message(), { now: T0, pendingTimeoutMs: TIMEOUT });
      const result = await send(store, message(), T0 + TIMEOUT, network);
      expect(result).toMatchObject({ status: "unknown", reason: "in_flight" });
      expect(network.calls).toBe(0);
    });

    it("converts a pending record past its timeout to unknown/stale_pending", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      await beginIdempotency(store, NAMESPACE, message(), { now: T0, pendingTimeoutMs: TIMEOUT });
      const result = await send(store, message(), T0 + TIMEOUT + 1, network);
      expect(result).toMatchObject({ status: "unknown", reason: "stale_pending" });
      expect(network.calls).toBe(0);
      const record = await store.get(KEY);
      expect(record?.state).toBe("unknown");
      expect(record?.expiresAt).toBeUndefined();
      // A later read finds the unknown record and gives the same reason.
      const again = await send(store, message(), T0 + 10 * TIMEOUT, network);
      expect(again).toMatchObject({ status: "unknown", reason: "stale_pending" });
      expect(network.calls).toBe(0);
    });

    it("returns the stored unknown reason for a key that ended unknown", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "unknown" };
      await send(store, message(), T0, network);
      network.status = "sent";
      const result = await send(store, message(), T0 + 1, network);
      expect(result).toMatchObject({ status: "unknown", reason: "timeout", provider: "fake" });
      expect(network.calls).toBe(1);
      expect((await store.get(KEY))?.expiresAt).toBeUndefined();
    });

    it("frees a not_sent key for a new claim, also with a new payload", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "not_sent" };
      await send(store, message(), T0, network);
      const record = await store.get(KEY);
      expect(record?.state).toBe("not_sent");
      expect(record?.expiresAt).toBe(T0 + NOT_SENT_RETENTION_MS);
      network.status = "sent";
      const result = await send(store, message({ subject: "Fixed" }), T0 + 1, network);
      expect(result.status).toBe("sent");
      expect(network.calls).toBe(2);
      expect((await store.get(KEY))?.attempts).toHaveLength(1);
    });

    it("frees a sent key after its retention ends", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      await send(store, message(), T0, network);
      await send(store, message(), T0 + SENT_RETENTION_MS, network);
      expect(network.calls).toBe(1);
      await send(store, message(), T0 + SENT_RETENTION_MS + 1, network);
      expect(network.calls).toBe(2);
    });

    it("lets a new send claim the key after a release", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      await beginIdempotency(store, NAMESPACE, message(), { now: T0, pendingTimeoutMs: TIMEOUT });
      await send(store, message(), T0 + TIMEOUT + 1, network);
      expect(await store.release(KEY, { expectedState: "unknown" })).toBe(true);
      expect(await store.get(KEY)).toBeNull();
      const result = await send(store, message(), T0 + TIMEOUT + 2, network);
      expect(result.status).toBe("sent");
      expect(network.calls).toBe(1);
    });

    it("releases only an unknown key", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      await send(store, message(), T0, network);
      expect(await store.release(KEY, { expectedState: "unknown" })).toBe(false);
      expect((await store.get(KEY))?.state).toBe("sent");
      await beginIdempotency(store, NAMESPACE, message({ idempotencyKey: "p" }), { now: T0 });
      expect(await store.release(`${NAMESPACE}:p`, { expectedState: "unknown" })).toBe(false);
      expect(await store.release(`${NAMESPACE}:missing`, { expectedState: "unknown" })).toBe(false);
    });

    it("ignores a late write with an old claim id after a release", async () => {
      const { store } = await setup();
      const old = await beginIdempotency(store, NAMESPACE, message(), {
        now: T0,
        pendingTimeoutMs: TIMEOUT,
      });
      if (!old.proceed) throw new Error("expected a claim");
      await beginIdempotency(store, NAMESPACE, message(), {
        now: T0 + TIMEOUT + 1,
        pendingTimeoutMs: TIMEOUT,
      });
      const late: IdempotencyAttempt[] = [{ provider: "fake", status: "sent", at: T0 + 1 }];

      await store.release(KEY, { expectedState: "unknown" });
      const afterRelease = await finalizeIdempotency(store, {
        key: old.key,
        claimId: old.claimId,
        attempts: late,
        now: T0 + TIMEOUT + 2,
      });
      expect(afterRelease.applied).toBe(false);
      expect(await store.get(KEY)).toBeNull();

      const fresh = await beginIdempotency(store, NAMESPACE, message(), {
        now: T0 + TIMEOUT + 3,
        pendingTimeoutMs: TIMEOUT,
      });
      if (!fresh.proceed) throw new Error("expected a claim");
      const lateAgain = await finalizeIdempotency(store, {
        key: old.key,
        claimId: old.claimId,
        attempts: late,
        now: T0 + TIMEOUT + 4,
      });
      expect(lateAgain.applied).toBe(false);
      expect(
        await store.appendAttempt({
          key: old.key,
          claimId: old.claimId,
          attempt: late[0] as IdempotencyAttempt,
          now: T0 + TIMEOUT + 4,
        }),
      ).toBe(false);
      const record = await store.get(KEY);
      expect(record).toMatchObject({ state: "pending", claimId: fresh.claimId, attempts: [] });
    });

    it("appends attempts to the current claim only", async () => {
      const { store } = await setup();
      const begin = await beginIdempotency(store, NAMESPACE, message(), { now: T0 });
      if (!begin.proceed) throw new Error("expected a claim");
      const attempt: IdempotencyAttempt = {
        provider: "a",
        status: "not_sent",
        reason: "daily_cap",
        at: T0 + 1,
      };
      expect(
        await store.appendAttempt({ key: begin.key, claimId: begin.claimId, attempt, now: T0 + 1 }),
      ).toBe(true);
      expect(
        await store.appendAttempt({ key: begin.key, claimId: "other", attempt, now: T0 + 1 }),
      ).toBe(false);
      const record = await store.get(KEY);
      expect(record?.attempts).toEqual([attempt]);
      expect(record?.updatedAt).toBe(T0 + 1);
      expect(record?.state).toBe("pending");
    });

    it("purges expired sent and not_sent rows and keeps pending and unknown rows", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      await send(store, message({ idempotencyKey: "sent-old" }), T0, network);
      await send(store, message({ idempotencyKey: "sent-new" }), T0 + SENT_RETENTION_MS, network);
      network.status = "not_sent";
      await send(store, message({ idempotencyKey: "not-sent-old" }), T0, network);
      network.status = "unknown";
      await send(store, message({ idempotencyKey: "unknown-old" }), T0, network);
      await beginIdempotency(store, NAMESPACE, message({ idempotencyKey: "pending-old" }), {
        now: T0,
      });

      const later = T0 + SENT_RETENTION_MS + 1;
      expect(await store.purgeExpired(later)).toBe(2);
      expect(await store.get(`${NAMESPACE}:sent-old`)).toBeNull();
      expect(await store.get(`${NAMESPACE}:not-sent-old`)).toBeNull();
      expect((await store.get(`${NAMESPACE}:sent-new`))?.state).toBe("sent");
      expect((await store.get(`${NAMESPACE}:unknown-old`))?.state).toBe("unknown");
      expect((await store.get(`${NAMESPACE}:pending-old`))?.state).toBe("pending");
      // Pending and unknown rows stay at any age.
      expect(await store.purgeExpired(Number.MAX_SAFE_INTEGER)).toBe(1);
      expect((await store.get(`${NAMESPACE}:unknown-old`))?.state).toBe("unknown");
      expect((await store.get(`${NAMESPACE}:pending-old`))?.state).toBe("pending");
    });

    it("stores no recipient address and no API key", async () => {
      const { store, rawRow } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      await send(
        store,
        message({ headers: { "X-Api-Key-Echo": API_KEY }, cc: ["carl.private@example.com"] }),
        T0,
        network,
      );
      const row = JSON.stringify(await rawRow(KEY));
      expect(row).toContain("invoice-42");
      expect(row).not.toContain(RECIPIENT);
      expect(row).not.toContain("carl.private");
      expect(row).not.toContain("example.com");
      expect(row).not.toContain(API_KEY);
      expect(row).not.toContain("Invoice 42");
    });
  });
}
