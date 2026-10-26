import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  base64ToBytesFallback,
  bytesToBase64,
  bytesToBase64Fallback,
  hasNativeBase64,
} from "../../src/internal/encoding";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let start = 0; start < length; start += 65536) {
    crypto.getRandomValues(bytes.subarray(start, start + 65536));
  }
  return bytes;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("base64 (workerd)", () => {
  it("reports whether the native API exists", () => {
    expect(typeof hasNativeBase64).toBe("boolean");
  });

  it("gives the same text through the native and the fallback paths", () => {
    for (const length of [0, 1, 2, 3, 24576, 24577, 5 * 1024 * 1024]) {
      const bytes = randomBytes(length);
      const native = bytesToBase64(bytes);
      const fallback = bytesToBase64Fallback(bytes);
      expect(native === fallback).toBe(true);
      expect(sameBytes(base64ToBytes(native), bytes)).toBe(true);
      expect(sameBytes(base64ToBytesFallback(fallback), bytes)).toBe(true);
    }
  });
});
