// A check for the bulk dedupe methods. A repeated key in one call is a programmer error.

/** Throws a TypeError when a key occurs more than once. */
export function assertDistinctKeys(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("claimMany needs distinct keys.");
  }
}
