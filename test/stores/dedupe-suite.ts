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
