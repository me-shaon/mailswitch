import { describe, expect, it } from "vitest";
import type { DedupeClaimOutcome, DedupeStore } from "../../src/stores/types";

const T0 = 1_800_000_000_000;
const LEASE = 60_000;
const TTL = 7 * 24 * 60 * 60 * 1000;

/** Returns the lease id of a `new` outcome, and fails the test for any other outcome. */
function leaseOf(outcome: DedupeClaimOutcome): string {
  if (outcome.status !== "new") throw new Error(`Expected new, got ${outcome.status}`);
  return outcome.leaseId;
}

/** The shared behavior of every `DedupeStore`. */
export function dedupeStoreSuite(name: string, make: () => Promise<DedupeStore>): void {
  describe(`${name} DedupeStore`, () => {
    it("claims a free key once and reports in_flight during the lease", async () => {
      const store = await make();
      const first = await store.claim({ key: "k", leaseMs: LEASE, now: T0 });
      expect(leaseOf(first)).toMatch(/\S/);
      expect(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + 1000 })).toEqual({
        status: "in_flight",
      });
    });

    it("gives one new outcome to parallel claims", async () => {
      const store = await make();
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => store.claim({ key: "p", leaseMs: LEASE, now: T0 })),
      );
      expect(outcomes.filter((outcome) => outcome.status === "new")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "in_flight")).toHaveLength(4);
    });

    it("re-claims a key whose lease expired without a commit, with a new lease id", async () => {
      const store = await make();
      const a = leaseOf(await store.claim({ key: "k", leaseMs: LEASE, now: T0 }));
      const b = leaseOf(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE }));
      expect(b).not.toBe(a);
    });

    it("reports duplicate after a commit until the TTL passes", async () => {
      const store = await make();
      const leaseId = leaseOf(await store.claim({ key: "k", leaseMs: LEASE, now: T0 }));
      expect(await store.commit({ key: "k", leaseId, ttlMs: TTL, now: T0 + 10 })).toBe(true);
      expect(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE * 2 })).toEqual({
        status: "duplicate",
      });
      const after = await store.claim({ key: "k", leaseMs: LEASE, now: T0 + 10 + TTL });
      expect(after.status).toBe("new");
    });

    it("frees an uncommitted key on release and keeps a committed key", async () => {
      const store = await make();
      const a = leaseOf(await store.claim({ key: "a", leaseMs: LEASE, now: T0 }));
      await store.release({ key: "a", leaseId: a });
      expect((await store.claim({ key: "a", leaseMs: LEASE, now: T0 + 1 })).status).toBe("new");
      const b = leaseOf(await store.claim({ key: "b", leaseMs: LEASE, now: T0 }));
      await store.commit({ key: "b", leaseId: b, ttlMs: TTL, now: T0 });
      await store.release({ key: "b", leaseId: b });
      const again = await store.claim({ key: "b", leaseMs: LEASE, now: T0 + 1 });
      expect(again.status).toBe("duplicate");
    });

    it("keeps a newer claim when a stale holder releases", async () => {
      const store = await make();
      const a = leaseOf(await store.claim({ key: "k", leaseMs: LEASE, now: T0 }));
      // A outlives its lease. B claims the key.
      const b = leaseOf(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE + 1 }));
      await store.release({ key: "k", leaseId: a });
      const third = await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE + 2 });
      expect(third.status).toBe("in_flight");
      await store.release({ key: "k", leaseId: b });
      const fourth = await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE + 3 });
      expect(fourth.status).toBe("new");
    });

    it("refuses a commit from a stale holder and accepts the newer holder's commit", async () => {
      const store = await make();
      const a = leaseOf(await store.claim({ key: "k", leaseMs: LEASE, now: T0 }));
      const b = leaseOf(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE + 1 }));
      const at = T0 + LEASE + 2;
      expect(await store.commit({ key: "k", leaseId: a, ttlMs: TTL, now: at })).toBe(false);
      // B still holds a live lease, so a third request waits.
      const third = await store.claim({ key: "k", leaseMs: LEASE, now: at + 1 });
      expect(third.status).toBe("in_flight");
      expect(await store.commit({ key: "k", leaseId: b, ttlMs: TTL, now: at + 2 })).toBe(true);
      const later = await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE * 3 });
      expect(later.status).toBe("duplicate");
      // A stale holder cannot change the TTL of a key that another lease committed.
      expect(await store.commit({ key: "k", leaseId: a, ttlMs: 1, now: T0 + LEASE * 3 })).toBe(
        false,
      );
      const last = await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE * 4 });
      expect(last.status).toBe("duplicate");
    });

    it("commits a late ack when the lease expired and no one claimed the key again", async () => {
      const store = await make();
      const a = leaseOf(await store.claim({ key: "k", leaseMs: LEASE, now: T0 }));
      expect(await store.commit({ key: "k", leaseId: a, ttlMs: TTL, now: T0 + LEASE * 2 })).toBe(
        true,
      );
      const later = await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE * 3 });
      expect(later.status).toBe("duplicate");
    });

    it("purges expired keys and expired leases, and keeps live keys", async () => {
      const store = await make();
      const old = leaseOf(await store.claim({ key: "old", leaseMs: LEASE, now: T0 }));
      await store.commit({ key: "old", leaseId: old, ttlMs: TTL, now: T0 });
      const live = leaseOf(await store.claim({ key: "live", leaseMs: LEASE, now: T0 }));
      await store.commit({ key: "live", leaseId: live, ttlMs: TTL * 2, now: T0 });
      await store.claim({ key: "lease", leaseMs: LEASE, now: T0 });
      expect(await store.purgeExpired(T0 + TTL + 1)).toBe(2);
      const kept = await store.claim({ key: "live", leaseMs: LEASE, now: T0 + TTL + 2 });
      expect(kept.status).toBe("duplicate");
    });
  });
}

/** A `DedupeStore` with the three optional bulk methods. */
export type BulkDedupeStore = DedupeStore &
  Required<Pick<DedupeStore, "claimMany" | "commitMany" | "releaseMany">>;

/** A small seeded random number generator, so a failure repeats. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

type KeyState = "free" | "held" | "committed" | "expired_lease" | "expired_commit";
const KEY_STATES: readonly KeyState[] = [
  "free",
  "held",
  "committed",
  "expired_lease",
  "expired_commit",
];

/** Puts a key in a state for a claim at `T0 + LEASE * 2`. */
async function setState(store: DedupeStore, key: string, state: KeyState): Promise<void> {
  if (state === "free") return;
  const at = state === "held" ? T0 + LEASE + 1 : T0;
  const leaseId = leaseOf(await store.claim({ key, leaseMs: LEASE, now: at }));
  if (state === "committed") await store.commit({ key, leaseId, ttlMs: TTL, now: at });
  if (state === "expired_commit") await store.commit({ key, leaseId, ttlMs: 10, now: at });
}

/** Returns the leases of a list of `new` outcomes. */
function leasesOf(keys: readonly string[], outcomes: readonly DedupeClaimOutcome[]) {
  return outcomes.map((outcome, i) => ({ key: keys[i] as string, leaseId: leaseOf(outcome) }));
}

/**
 * The shared behavior of the optional bulk methods of a `DedupeStore`. A store that
 * implements them must give the same results as its single methods.
 */
export function dedupeBulkSuite(name: string, make: () => Promise<BulkDedupeStore>): void {
  describe(`${name} DedupeStore bulk methods`, () => {
    it("claims 3 new keys with distinct lease ids", async () => {
      const store = await make();
      const outcomes = await store.claimMany({ keys: ["a", "b", "c"], leaseMs: LEASE, now: T0 });
      expect(new Set(outcomes.map(leaseOf)).size).toBe(3);
    });

    it("gives in_flight, duplicate, and new in input order", async () => {
      const store = await make();
      await store.claim({ key: "held", leaseMs: LEASE, now: T0 });
      const done = leaseOf(await store.claim({ key: "done", leaseMs: LEASE, now: T0 }));
      await store.commit({ key: "done", leaseId: done, ttlMs: TTL, now: T0 });
      const outcomes = await store.claimMany({
        keys: ["held", "done", "fresh"],
        leaseMs: LEASE,
        now: T0 + 1,
      });
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["in_flight", "duplicate", "new"]);
    });

    it("throws a TypeError for a repeated key and claims no key", async () => {
      const store = await make();
      await expect(
        store.claimMany({ keys: ["a", "b", "a"], leaseMs: LEASE, now: T0 }),
      ).rejects.toThrow(TypeError);
      const after = await store.claimMany({ keys: ["a", "b"], leaseMs: LEASE, now: T0 + 1 });
      expect(after.map((outcome) => outcome.status)).toEqual(["new", "new"]);
    });

    it("gives new with a fresh lease id for a key whose lease expired", async () => {
      const store = await make();
      const [first] = await store.claimMany({ keys: ["k"], leaseMs: LEASE, now: T0 });
      const [second] = await store.claimMany({ keys: ["k"], leaseMs: LEASE, now: T0 + LEASE });
      if (!first || !second) throw new Error("Expected one outcome for each key.");
      expect(leaseOf(second)).not.toBe(leaseOf(first));
    });

    it("gives duplicate for each key after commitMany", async () => {
      const store = await make();
      const keys = ["a", "b", "c"];
      const leases = leasesOf(keys, await store.claimMany({ keys, leaseMs: LEASE, now: T0 }));
      expect(await store.commitMany({ leases, ttlMs: TTL, now: T0 + 1 })).toEqual([
        true,
        true,
        true,
      ]);
      const again = await store.claimMany({ keys, leaseMs: LEASE, now: T0 + LEASE * 2 });
      expect(again.map((outcome) => outcome.status)).toEqual([
        "duplicate",
        "duplicate",
        "duplicate",
      ]);
    });

    it("refuses the commit of a stale holder in commitMany and keeps the others", async () => {
      const store = await make();
      const a = leaseOf(await store.claim({ key: "a", leaseMs: LEASE, now: T0 }));
      const b = leaseOf(await store.claim({ key: "b", leaseMs: LEASE, now: T0 }));
      await store.claim({ key: "a", leaseMs: LEASE, now: T0 + LEASE + 1 });
      const leases = [
        { key: "a", leaseId: a },
        { key: "b", leaseId: b },
      ];
      expect(await store.commitMany({ leases, ttlMs: TTL, now: T0 + LEASE + 2 })).toEqual([
        false,
        true,
      ]);
    });

    it("frees each key on releaseMany and keeps a newer lease", async () => {
      const store = await make();
      const keys = ["a", "b"];
      const leases = leasesOf(keys, await store.claimMany({ keys, leaseMs: LEASE, now: T0 }));
      await store.releaseMany(leases);
      const again = await store.claimMany({ keys, leaseMs: LEASE, now: T0 + 1 });
      expect(again.map((outcome) => outcome.status)).toEqual(["new", "new"]);

      // A stale holder releases after a newer request claimed the key.
      const stale = leaseOf(await store.claim({ key: "s", leaseMs: LEASE, now: T0 }));
      await store.claim({ key: "s", leaseMs: LEASE, now: T0 + LEASE + 1 });
      await store.releaseMany([{ key: "s", leaseId: stale }]);
      const third = await store.claim({ key: "s", leaseMs: LEASE, now: T0 + LEASE + 2 });
      expect(third.status).toBe("in_flight");
    });

    it("accepts empty lists", async () => {
      const store = await make();
      expect(await store.claimMany({ keys: [], leaseMs: LEASE, now: T0 })).toEqual([]);
      expect(await store.commitMany({ leases: [], ttlMs: TTL, now: T0 })).toEqual([]);
      await store.releaseMany([]);
    });

    it("gives the same outcomes as claim in a loop for random key states", async () => {
      const store = await make();
      const random = seeded(20_261_027);
      const states = Array.from(
        { length: 40 },
        () => KEY_STATES[Math.floor(random() * KEY_STATES.length)] as KeyState,
      );
      for (const [i, state] of states.entries()) {
        await setState(store, `bulk:${i}`, state);
        await setState(store, `loop:${i}`, state);
      }
      const at = T0 + LEASE * 2;
      const bulk = await store.claimMany({
        keys: states.map((_, i) => `bulk:${i}`),
        leaseMs: LEASE,
        now: at,
      });
      const loop: DedupeClaimOutcome[] = [];
      for (const i of states.keys()) {
        loop.push(await store.claim({ key: `loop:${i}`, leaseMs: LEASE, now: at }));
      }
      const statuses = bulk.map((outcome) => outcome.status);
      expect(statuses).toEqual(loop.map((outcome) => outcome.status));
      expect(new Set(statuses)).toEqual(new Set(["new", "in_flight", "duplicate"]));
    });
  });
}
