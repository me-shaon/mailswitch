// Detection of the optional bulk store methods. A bulk method is used only when the object
// in the prototype chain that defines it also defines each single method that it
// replaces. A subclass of a built-in store that overrides a single method inherits the
// bulk method of its parent. Without this check, the override would stop running.

import type { DailyCapStore, DedupeStore, IdempotencyStore } from "../stores/types";

/** An `IdempotencyStore` with the three optional bulk methods. */
export type BulkIdempotencyStore = IdempotencyStore &
  Required<Pick<IdempotencyStore, "claimMany" | "touchMany" | "finishMany">>;

/** A `DailyCapStore` with the two optional bulk methods. */
export type BulkDailyCapStore = DailyCapStore &
  Required<Pick<DailyCapStore, "reserveMany" | "releaseMany">>;

/** A `DedupeStore` with the three optional bulk methods. */
export type BulkDedupeStore = DedupeStore &
  Required<Pick<DedupeStore, "claimMany" | "commitMany" | "releaseMany">>;

/** The first object in the prototype chain that has `name` as an own property. */
function ownerOf(value: object, name: string): object | undefined {
  let current: object | null = value;
  while (current !== null) {
    if (Object.hasOwn(current, name)) return current;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

/**
 * True when `bulk` and `single` are functions and come from the same object in the
 * prototype chain.
 */
function sameOwner(store: object, bulk: string, single: string): boolean {
  const record = store as Record<string, unknown>;
  return (
    typeof record[bulk] === "function" &&
    typeof record[single] === "function" &&
    ownerOf(store, bulk) === ownerOf(store, single)
  );
}

/**
 * True when `sendBatch` can use the bulk methods of an idempotency store. Each of
 * `claimMany`, `touchMany`, and `finishMany` must come from the same object as `claim`,
 * `touch`, and `finish` in that order.
 */
export function hasBulkIdempotency(store: IdempotencyStore): store is BulkIdempotencyStore {
  return (
    sameOwner(store, "claimMany", "claim") &&
    sameOwner(store, "touchMany", "touch") &&
    sameOwner(store, "finishMany", "finish")
  );
}

/**
 * True when `sendBatch` can use the bulk methods of a daily cap store. `reserveMany` must
 * come from the same object as `reserve`, and `releaseMany` from the same object as
 * `release`.
 */
export function hasBulkDailyCap(store: DailyCapStore): store is BulkDailyCapStore {
  return sameOwner(store, "reserveMany", "reserve") && sameOwner(store, "releaseMany", "release");
}

/**
 * True when `handleWebhook` can use the bulk methods of a dedupe store. Each of
 * `claimMany`, `commitMany`, and `releaseMany` must come from the same object as `claim`,
 * `commit`, and `release` in that order.
 */
export function hasBulkDedupe(store: DedupeStore): store is BulkDedupeStore {
  return (
    sameOwner(store, "claimMany", "claim") &&
    sameOwner(store, "commitMany", "commit") &&
    sameOwner(store, "releaseMany", "release")
  );
}
