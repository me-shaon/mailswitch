import { describe, expect, it } from "vitest";
import type { DedupeStore } from "../../src/stores/types";

const T0 = 1_800_000_000_000;
const LEASE = 60_000;
const TTL = 7 * 24 * 60 * 60 * 1000;

/** The shared behavior of every `DedupeStore`. */
export function dedupeStoreSuite(name: string, make: () => Promise<DedupeStore>): void {
  describe(`${name} DedupeStore`, () => {
    it("claims a free key once and reports in_flight during the lease", async () => {
      const store = await make();
      expect(await store.claim({ key: "k", leaseMs: LEASE, now: T0 })).toBe("new");
      expect(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + 1000 })).toBe("in_flight");
    });

    it("gives one new outcome to parallel claims", async () => {
      const store = await make();
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => store.claim({ key: "p", leaseMs: LEASE, now: T0 })),
      );
      expect(outcomes.filter((outcome) => outcome === "new")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === "in_flight")).toHaveLength(4);
    });

    it("re-claims a key whose lease expired without a commit", async () => {
      const store = await make();
      await store.claim({ key: "k", leaseMs: LEASE, now: T0 });
      expect(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE })).toBe("new");
    });

    it("reports duplicate after a commit until the TTL passes", async () => {
      const store = await make();
      await store.claim({ key: "k", leaseMs: LEASE, now: T0 });
      await store.commit({ key: "k", ttlMs: TTL, now: T0 + 10 });
      expect(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + LEASE * 2 })).toBe(
        "duplicate",
      );
      expect(await store.claim({ key: "k", leaseMs: LEASE, now: T0 + 10 + TTL })).toBe("new");
    });

    it("frees an uncommitted key on release and keeps a committed key", async () => {
      const store = await make();
      await store.claim({ key: "a", leaseMs: LEASE, now: T0 });
      await store.release({ key: "a" });
      expect(await store.claim({ key: "a", leaseMs: LEASE, now: T0 + 1 })).toBe("new");
      await store.claim({ key: "b", leaseMs: LEASE, now: T0 });
      await store.commit({ key: "b", ttlMs: TTL, now: T0 });
      await store.release({ key: "b" });
      expect(await store.claim({ key: "b", leaseMs: LEASE, now: T0 + 1 })).toBe("duplicate");
    });

    it("purges expired keys and expired leases, and keeps live keys", async () => {
      const store = await make();
      await store.claim({ key: "old", leaseMs: LEASE, now: T0 });
      await store.commit({ key: "old", ttlMs: TTL, now: T0 });
      await store.claim({ key: "live", leaseMs: LEASE, now: T0 });
      await store.commit({ key: "live", ttlMs: TTL * 2, now: T0 });
      await store.claim({ key: "lease", leaseMs: LEASE, now: T0 });
      expect(await store.purgeExpired(T0 + TTL + 1)).toBe(2);
      expect(await store.claim({ key: "live", leaseMs: LEASE, now: T0 + TTL + 2 })).toBe(
        "duplicate",
      );
    });
  });
}
