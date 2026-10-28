// Store chunks. `sendBatch` gives each bulk store call at most `STORE_CHUNK` inputs.

/** The most inputs in one bulk store call. */
export const STORE_CHUNK = 100;

/** Splits a list into parts of at most `size` items, in order. */
export function chunks<T>(list: readonly T[], size: number = STORE_CHUNK): T[][] {
  const parts: T[][] = [];
  for (let at = 0; at < list.length; at += size) parts.push(list.slice(at, at + size));
  return parts;
}
