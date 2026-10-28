import { describe, expect, it } from "vitest";
import { hasBulkDailyCap, hasBulkIdempotency } from "../../src/internal/bulk-methods";
import type {
  DailyCapReservation,
  DailyCapStore,
  IdempotencyClaimOutcome,
  IdempotencyStore,
} from "../../src/stores/types";

// A custom store with only the single methods still fits each interface.
function singleIdempotency(): IdempotencyStore {
  return {
    claim: async (): Promise<IdempotencyClaimOutcome> => ({ kind: "claimed" }),
    touch: async () => true,
    finish: async () => true,
    release: async () => false,
    get: async () => null,
    purgeExpired: async () => 0,
  };
}

function singleDailyCap(): DailyCapStore {
  return {
    reserve: async (): Promise<DailyCapReservation> => ({ ok: true, bucketStart: 0 }),
    release: async () => {},
    fill: async () => {},
    used: async () => 0,
  };
}

function bulkIdempotency(): IdempotencyStore {
  return {
    ...singleIdempotency(),
    claimMany: async (inputs) => inputs.map((): IdempotencyClaimOutcome => ({ kind: "claimed" })),
    touchMany: async (inputs) => inputs.map(() => true),
    finishMany: async (inputs) => inputs.map(() => true),
  };
}

class BaseIdempotency implements IdempotencyStore {
  async claim(): Promise<IdempotencyClaimOutcome> {
    return { kind: "claimed" };
  }
  async touch(): Promise<boolean> {
    return true;
  }
  async finish(): Promise<boolean> {
    return true;
  }
  async release(): Promise<boolean> {
    return false;
  }
  async get(): Promise<null> {
    return null;
  }
  async purgeExpired(): Promise<number> {
    return 0;
  }
  async claimMany(inputs: readonly unknown[]): Promise<IdempotencyClaimOutcome[]> {
    return inputs.map(() => ({ kind: "claimed" }));
  }
  async touchMany(inputs: readonly unknown[]): Promise<boolean[]> {
    return inputs.map(() => true);
  }
  async finishMany(inputs: readonly unknown[]): Promise<boolean[]> {
    return inputs.map(() => true);
  }
}

class BaseDailyCap implements DailyCapStore {
  async reserve(): Promise<DailyCapReservation> {
    return { ok: true, bucketStart: 0 };
  }
  async release(): Promise<void> {}
  async fill(): Promise<void> {}
  async used(): Promise<number> {
    return 0;
  }
  async reserveMany(input: { count: number }): Promise<DailyCapReservation[]> {
    return Array.from({ length: input.count }, () => ({ ok: true, bucketStart: 0 }));
  }
  async releaseMany(): Promise<void> {}
}

describe("hasBulkIdempotency", () => {
  it("is false for a store with only the single methods", () => {
    expect(hasBulkIdempotency(singleIdempotency())).toBe(false);
  });

  it("is true for a plain object with all methods", () => {
    expect(hasBulkIdempotency(bulkIdempotency())).toBe(true);
  });

  it("is false when one bulk method is missing", () => {
    const { finishMany: _, ...store } = bulkIdempotency();
    expect(hasBulkIdempotency(store)).toBe(false);
  });

  it("is true for a class instance that inherits all methods", () => {
    expect(hasBulkIdempotency(new BaseIdempotency())).toBe(true);
  });

  it("is false for a subclass that overrides touch only", () => {
    class Sub extends BaseIdempotency {
      override async touch(): Promise<boolean> {
        return false;
      }
    }
    expect(hasBulkIdempotency(new Sub())).toBe(false);
  });

  it("is true for a subclass that overrides touch and touchMany", () => {
    class Sub extends BaseIdempotency {
      override async touch(): Promise<boolean> {
        return false;
      }
      override async touchMany(inputs: readonly unknown[]): Promise<boolean[]> {
        return inputs.map(() => false);
      }
    }
    expect(hasBulkIdempotency(new Sub())).toBe(true);
  });

  it("is false for a subclass that overrides touchMany only", () => {
    class Sub extends BaseIdempotency {
      override async touchMany(inputs: readonly unknown[]): Promise<boolean[]> {
        return inputs.map(() => false);
      }
    }
    expect(hasBulkIdempotency(new Sub())).toBe(false);
  });

  it("is false for an instance with a patched finish", () => {
    const store = new BaseIdempotency();
    store.finish = async () => false;
    expect(hasBulkIdempotency(store)).toBe(false);
  });
});

describe("hasBulkDailyCap", () => {
  it("is false for a store with only the single methods", () => {
    expect(hasBulkDailyCap(singleDailyCap())).toBe(false);
  });

  it("is true for a plain object with all methods", () => {
    const store: DailyCapStore = {
      ...singleDailyCap(),
      reserveMany: async (input) =>
        Array.from({ length: input.count }, () => ({ ok: true, bucketStart: 0 })),
      releaseMany: async () => {},
    };
    expect(hasBulkDailyCap(store)).toBe(true);
  });

  it("is true for a class instance that inherits all methods", () => {
    expect(hasBulkDailyCap(new BaseDailyCap())).toBe(true);
  });

  it("is false for a subclass that overrides reserve only", () => {
    class Sub extends BaseDailyCap {
      override async reserve(): Promise<DailyCapReservation> {
        return { ok: false, resetAt: 0 };
      }
    }
    expect(hasBulkDailyCap(new Sub())).toBe(false);
  });

  it("is false for a subclass that overrides release only", () => {
    class Sub extends BaseDailyCap {
      override async release(): Promise<void> {}
    }
    expect(hasBulkDailyCap(new Sub())).toBe(false);
  });

  it("is true for a subclass that overrides reserve and reserveMany", () => {
    class Sub extends BaseDailyCap {
      override async reserve(): Promise<DailyCapReservation> {
        return { ok: false, resetAt: 0 };
      }
      override async reserveMany(input: { count: number }): Promise<DailyCapReservation[]> {
        return Array.from({ length: input.count }, () => ({ ok: false, resetAt: 0 }));
      }
    }
    expect(hasBulkDailyCap(new Sub())).toBe(true);
  });
});
