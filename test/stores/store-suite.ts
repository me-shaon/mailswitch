import { describe, expect, it } from "vitest";
import {
  beginIdempotency,
  finalizeIdempotency,
  NOT_SENT_RETENTION_MS,
  SENT_RETENTION_MS,
} from "../../src/core/idempotency";
import type { OutgoingMessage, SendResult } from "../../src/core/types";
import type { BulkIdempotencyStore } from "../../src/internal/bulk-methods";
import type {
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyStore,
  IdempotencyTouchInput,
} from "../../src/stores/types";

/** What the suite needs from one store implementation. */
export interface StoreHarness {
  store: IdempotencyStore;
  /** The stored row exactly as the backend holds it. */
  rawRow(key: string): Promise<unknown>;
  /**
   * Runs the expiry of a store that has no `purgeExpired` scan, such as the Durable
   * Object store, over the given keys. Returns the number of deleted records.
   */
  purge?(now: number, keys: readonly string[]): Promise<number>;
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
        await store.touch({
          key: old.key,
          claimId: old.claimId,
          attempt: late[0] as IdempotencyAttempt,
          now: T0 + TIMEOUT + 4,
        }),
      ).toBe(false);
      const record = await store.get(KEY);
      expect(record).toMatchObject({ state: "pending", claimId: fresh.claimId, attempts: [] });
    });

    it("touches the current claim only, with an optional attempt", async () => {
      const { store } = await setup();
      const begin = await beginIdempotency(store, NAMESPACE, message(), { now: T0 });
      if (!begin.proceed) throw new Error("expected a claim");
      const attempt: IdempotencyAttempt = {
        provider: "a",
        status: "not_sent",
        reason: "daily_cap",
        at: T0 + 1,
      };
      expect(await store.touch({ key: begin.key, claimId: begin.claimId, now: T0 + 1 })).toBe(true);
      expect((await store.get(KEY))?.attempts).toEqual([]);
      expect(
        await store.touch({ key: begin.key, claimId: begin.claimId, attempt, now: T0 + 2 }),
      ).toBe(true);
      expect(await store.touch({ key: begin.key, claimId: "other", attempt, now: T0 + 3 })).toBe(
        false,
      );
      const record = await store.get(KEY);
      expect(record?.attempts).toEqual([attempt]);
      expect(record?.updatedAt).toBe(T0 + 2);
      expect(record?.claimedAt).toBe(T0);
      expect(record?.state).toBe("pending");
    });

    it("refuses a touch on a record that is not pending", async () => {
      const { store } = await setup();
      const begin = await beginIdempotency(store, NAMESPACE, message(), {
        now: T0,
        pendingTimeoutMs: TIMEOUT,
      });
      if (!begin.proceed) throw new Error("expected a claim");
      await finalizeIdempotency(store, {
        key: begin.key,
        claimId: begin.claimId,
        attempts: [{ provider: "fake", status: "sent", at: T0 + 1 }],
        now: T0 + 1,
      });
      expect(await store.touch({ key: begin.key, claimId: begin.claimId, now: T0 + 2 })).toBe(
        false,
      );
      const record = await store.get(KEY);
      expect(record).toMatchObject({ state: "sent", updatedAt: T0 + 1 });

      // A claim that went stale is unknown, so its owner cannot touch it either.
      const other = message({ idempotencyKey: "stale" });
      const stale = await beginIdempotency(store, NAMESPACE, other, { now: T0 });
      if (!stale.proceed) throw new Error("expected a claim");
      await beginIdempotency(store, NAMESPACE, other, {
        now: T0 + TIMEOUT + 1,
        pendingTimeoutMs: TIMEOUT,
      });
      expect(await store.touch({ key: stale.key, claimId: stale.claimId, now: T0 + 2 })).toBe(
        false,
      );
      expect((await store.get(stale.key))?.state).toBe("unknown");
    });

    it("measures staleness from the last touch, not from the claim", async () => {
      const { store } = await setup();
      const network: Network = { calls: 0, status: "sent" };
      const begin = await beginIdempotency(store, NAMESPACE, message(), {
        now: T0,
        pendingTimeoutMs: TIMEOUT,
      });
      if (!begin.proceed) throw new Error("expected a claim");
      const touched = T0 + TIMEOUT - 1;
      expect(await store.touch({ key: begin.key, claimId: begin.claimId, now: touched })).toBe(
        true,
      );
      // The claim is older than the timeout, but its last touch is not.
      const repeat = await send(store, message(), T0 + TIMEOUT + 10, network);
      expect(repeat).toMatchObject({ status: "unknown", reason: "in_flight" });
      expect((await store.get(KEY))?.state).toBe("pending");
      // After a full timeout with no touch, the claim is stale.
      const late = await send(store, message(), touched + TIMEOUT + 1, network);
      expect(late).toMatchObject({ status: "unknown", reason: "stale_pending" });
      expect(network.calls).toBe(0);
    });

    it("purges expired sent and not_sent rows and keeps pending and unknown rows", async () => {
      const harness = await setup();
      const { store } = harness;
      const all = ["sent-old", "sent-new", "not-sent-old", "unknown-old", "pending-old"].map(
        (key) => `${NAMESPACE}:${key}`,
      );
      const purge = (now: number) =>
        harness.purge ? harness.purge(now, all) : store.purgeExpired(now);
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
      expect(await purge(later)).toBe(2);
      expect(await store.get(`${NAMESPACE}:sent-old`)).toBeNull();
      expect(await store.get(`${NAMESPACE}:not-sent-old`)).toBeNull();
      expect((await store.get(`${NAMESPACE}:sent-new`))?.state).toBe("sent");
      expect((await store.get(`${NAMESPACE}:unknown-old`))?.state).toBe("unknown");
      expect((await store.get(`${NAMESPACE}:pending-old`))?.state).toBe("pending");
      // Pending and unknown rows stay at any age.
      expect(await purge(Number.MAX_SAFE_INTEGER)).toBe(1);
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

/** A small seeded random number generator, so a failure repeats. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const HASH = "hash-a";
const OTHER_HASH = "hash-b";
/** The time of the bulk calls in the bulk suite. */
const AT = T0 + 10 * TIMEOUT;

type ClaimState =
  | "free"
  | "pending"
  | "stale"
  | "sent"
  | "sent_expired"
  | "not_sent"
  | "unknown"
  | "other_payload";
const CLAIM_STATES: readonly ClaimState[] = [
  "free",
  "pending",
  "stale",
  "sent",
  "sent_expired",
  "not_sent",
  "unknown",
  "other_payload",
];

/** Puts a key in a state for a claim at `AT`. */
async function setClaimState(store: IdempotencyStore, key: string, state: ClaimState) {
  if (state === "free") return;
  const at = state === "pending" ? AT - 1 : state === "stale" ? AT - TIMEOUT - 1 : T0;
  const payloadHash = state === "other_payload" ? OTHER_HASH : HASH;
  const claimId = `setup-${key}`;
  await store.claim({ key, payloadHash, claimId, now: at, pendingTimeoutMs: TIMEOUT });
  if (state === "pending" || state === "stale") return;
  const finalState = state === "sent_expired" || state === "other_payload" ? "sent" : state;
  await store.finish({
    key,
    claimId,
    state: finalState,
    attempts: [{ provider: "fake", status: finalState, at }],
    now: at,
    expiresAt: state === "sent_expired" ? AT - 1 : AT + SENT_RETENTION_MS,
  });
}

/** The parts of a record that do not depend on the key or the claim id. */
function shape(record: IdempotencyRecord | null | undefined): unknown {
  if (!record) return null;
  const { key: _key, claimId: _claimId, ...rest } = record;
  return rest;
}

function claimInput(key: string, claimId = `claim-${key}`): IdempotencyClaimInput {
  return { key, payloadHash: HASH, claimId, now: AT, pendingTimeoutMs: TIMEOUT };
}

/**
 * The shared behavior of the optional bulk methods of an `IdempotencyStore`. A store that
 * implements them must give the same results as its single methods in a loop.
 */
export function idempotencyBulkSuite(
  name: string,
  setup: () => Promise<{ store: BulkIdempotencyStore }>,
): void {
  describe(`${name} idempotency store bulk methods`, () => {
    it("gives the outcome of claim for each key state, in input order", async () => {
      const { store } = await setup();
      for (const state of CLAIM_STATES) await setClaimState(store, state, state);
      const outcomes = await store.claimMany(CLAIM_STATES.map((state) => claimInput(state)));
      expect(outcomes.map((outcome) => outcome.kind)).toEqual([
        "claimed",
        "pending",
        "stale",
        "existing",
        "claimed",
        "claimed",
        "existing",
        "conflict",
      ]);
      for (const state of ["free", "sent_expired", "not_sent"]) {
        expect(await store.get(state)).toMatchObject({
          state: "pending",
          claimId: `claim-${state}`,
          attempts: [],
        });
      }
      expect((await store.get("stale"))?.state).toBe("unknown");
    });

    it("throws a TypeError for a repeated key and claims no key", async () => {
      const { store } = await setup();
      await expect(
        store.claimMany([claimInput("a"), claimInput("b"), claimInput("a", "again")]),
      ).rejects.toThrow(TypeError);
      expect(await store.get("a")).toBeNull();
      expect(await store.get("b")).toBeNull();
    });

    it("touches the current claims and returns false for a lost claim", async () => {
      const { store } = await setup();
      await store.claimMany([claimInput("a"), claimInput("b"), claimInput("c")]);
      // A later claim finds the claim of "b" stale and changes it to unknown.
      await store.claim({ ...claimInput("b", "newer"), now: AT + TIMEOUT + 1 });
      const attempt: IdempotencyAttempt = { provider: "fake", status: "not_sent", at: AT + 1 };
      const touched = await store.touchMany([
        { key: "a", claimId: "claim-a", now: AT + 1, attempt },
        { key: "b", claimId: "claim-b", now: AT + 1, attempt },
        { key: "c", claimId: "claim-c", now: AT + 2 },
        { key: "missing", claimId: "claim-missing", now: AT + 1 },
      ]);
      expect(touched).toEqual([true, false, true, false]);
      expect(await store.get("a")).toMatchObject({ updatedAt: AT + 1, attempts: [attempt] });
      expect(await store.get("c")).toMatchObject({ updatedAt: AT + 2, attempts: [] });
      expect((await store.get("b"))?.attempts).toEqual([]);
    });

    it("finishes the current claims and returns false for a fenced-out key", async () => {
      const { store } = await setup();
      await store.claimMany([claimInput("a"), claimInput("b")]);
      const attempts: IdempotencyAttempt[] = [{ provider: "fake", status: "sent", at: AT + 1 }];
      const finished = await store.finishMany([
        { key: "a", claimId: "claim-a", state: "sent", attempts, now: AT + 1, expiresAt: AT + 9 },
        { key: "b", claimId: "other", state: "sent", attempts, now: AT + 1, expiresAt: AT + 9 },
      ]);
      expect(finished).toEqual([true, false]);
      expect(await store.get("a")).toMatchObject({ state: "sent", attempts, expiresAt: AT + 9 });
      expect(await store.get("b")).toMatchObject({ state: "pending", attempts: [] });
    });

    it("accepts empty lists", async () => {
      const { store } = await setup();
      expect(await store.claimMany([])).toEqual([]);
      expect(await store.touchMany([])).toEqual([]);
      expect(await store.finishMany([])).toEqual([]);
    });

    it("gives the same outcomes as the single methods in a loop for random key states", async () => {
      const { store } = await setup();
      const random = seeded(20_261_028);
      const states = Array.from(
        { length: 40 },
        () => CLAIM_STATES[Math.floor(random() * CLAIM_STATES.length)] as ClaimState,
      );
      for (const [i, state] of states.entries()) {
        await setClaimState(store, `bulk:${i}`, state);
        await setClaimState(store, `loop:${i}`, state);
      }
      const bulk = await store.claimMany(states.map((_, i) => claimInput(`bulk:${i}`)));
      const loop: IdempotencyClaimOutcome[] = [];
      for (const i of states.keys()) loop.push(await store.claim(claimInput(`loop:${i}`)));
      const view = (outcome: IdempotencyClaimOutcome) =>
        outcome.kind === "claimed"
          ? outcome
          : { kind: outcome.kind, record: shape(outcome.record) };
      expect(bulk.map(view)).toEqual(loop.map(view));
      expect(new Set(bulk.map((outcome) => outcome.kind)).size).toBe(5);

      // Touch and finish each key with its own claim id or a wrong one.
      const owns = states.map(() => random() < 0.7);
      const claimIdOf = (prefix: string, i: number) =>
        owns[i] ? `claim-${prefix}:${i}` : "not-the-claim";
      const attempt: IdempotencyAttempt = { provider: "fake", status: "unknown", at: AT + 1 };
      const touchInput = (prefix: string, i: number): IdempotencyTouchInput => ({
        key: `${prefix}:${i}`,
        claimId: claimIdOf(prefix, i),
        now: AT + 1,
        ...(i % 2 === 0 ? { attempt } : {}),
      });
      const bulkTouch = await store.touchMany(states.map((_, i) => touchInput("bulk", i)));
      const loopTouch: boolean[] = [];
      for (const i of states.keys()) loopTouch.push(await store.touch(touchInput("loop", i)));
      expect(bulkTouch).toEqual(loopTouch);
      expect(bulkTouch).toContain(true);
      expect(bulkTouch).toContain(false);

      const finishInput = (prefix: string, i: number): IdempotencyFinishInput => ({
        key: `${prefix}:${i}`,
        claimId: claimIdOf(prefix, i),
        state: i % 3 === 0 ? "unknown" : "sent",
        attempts: [attempt],
        providerMessageId: `msg-${i}`,
        now: AT + 2,
        expiresAt: AT + SENT_RETENTION_MS,
      });
      const bulkFinish = await store.finishMany(states.map((_, i) => finishInput("bulk", i)));
      const loopFinish: boolean[] = [];
      for (const i of states.keys()) loopFinish.push(await store.finish(finishInput("loop", i)));
      expect(bulkFinish).toEqual(loopFinish);

      for (const i of states.keys()) {
        expect(shape(await store.get(`bulk:${i}`))).toEqual(shape(await store.get(`loop:${i}`)));
      }
    });
  });
}
