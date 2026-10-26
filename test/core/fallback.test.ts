import { describe, expect, it, vi } from "vitest";
import { allowFallback } from "../../src/core/fallback";
import type { NotSentResult, SentResult, UnknownResult } from "../../src/core/types";

const sent: SentResult = { status: "sent", provider: "a" };
const notSent: NotSentResult = {
  status: "not_sent",
  reason: "auth",
  message: "refused",
  provider: "a",
};
const unknown: UnknownResult = {
  status: "unknown",
  reason: "timeout",
  message: "timed out",
  provider: "a",
};

function logger() {
  return { warn: vi.fn() };
}

describe("allowFallback", () => {
  it("falls back after not_sent only, by default", () => {
    expect(allowFallback(notSent)).toBe(true);
    expect(allowFallback(sent)).toBe(false);
    expect(allowFallback(unknown)).toBe(false);
  });

  it("lets shouldFallback narrow a not_sent result", () => {
    expect(allowFallback(notSent, (result) => result.reason !== "auth")).toBe(false);
    expect(allowFallback(notSent, () => true)).toBe(true);
  });

  it("treats a value that is not true as no", () => {
    expect(allowFallback(notSent, (() => "yes") as never)).toBe(false);
  });

  it("ignores true for unknown and warns", () => {
    const log = logger();
    expect(allowFallback(unknown, () => true, log)).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toEqual({ provider: "a", reason: "timeout" });
  });

  it("does not warn when shouldFallback returns false for unknown", () => {
    const log = logger();
    expect(allowFallback(unknown, () => false, log)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("never calls shouldFallback for sent", () => {
    const callback = vi.fn(() => true);
    expect(allowFallback(sent, callback)).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it("counts a shouldFallback that throws as no, and warns without the error text", () => {
    const log = logger();
    const result = allowFallback(
      notSent,
      () => {
        throw new Error("secret detail");
      },
      log,
    );
    expect(result).toBe(false);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret detail");
  });

  it("survives a logger that throws", () => {
    const log = {
      warn: () => {
        throw new Error("logger down");
      },
    };
    expect(allowFallback(unknown, () => true, log)).toBe(false);
  });
});
