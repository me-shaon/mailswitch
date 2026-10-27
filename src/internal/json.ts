// Small readers for parsed JSON values of unknown shape.

/** The value as a field record when it is a plain object: not null and not an array. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
