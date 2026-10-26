import { describe, expect, it } from "vitest";
import {
  base64DecodedLength,
  base64Length,
  base64ToBytes,
  base64ToBytesFallback,
  bytesToBase64,
  bytesToBase64Fallback,
  bytesToHex,
  hasNativeBase64,
  isBase64,
  utf8,
  utf8ByteLength,
} from "../../src/internal/encoding";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // getRandomValues fills at most 65536 bytes per call.
  for (let start = 0; start < length; start += 65536) {
    crypto.getRandomValues(bytes.subarray(start, start + 65536));
  }
  return bytes;
}

// The Node Buffer is the reference encoder. The project has no Node type definitions,
// so this test reads it from globalThis with a minimal type.
interface ReferenceBuffer {
  toString(encoding: "base64" | "hex"): string;
  equals(other: ReferenceBuffer): boolean;
}
const { Buffer } = globalThis as unknown as {
  Buffer: { from(bytes: Uint8Array): ReferenceBuffer };
};

const FIVE_MB = 5 * 1024 * 1024;

describe("base64", () => {
  it("matches Buffer for a 5 MB attachment through the fallback path", () => {
    const bytes = randomBytes(FIVE_MB);
    const reference = Buffer.from(bytes).toString("base64");
    const encoded = bytesToBase64Fallback(bytes);
    expect(encoded === reference).toBe(true);
    expect(encoded.length).toBe(base64Length(bytes.length));
    const decoded = base64ToBytesFallback(encoded);
    expect(decoded && Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
  });

  it.skipIf(!hasNativeBase64)(
    "matches Buffer for a 5 MB attachment through the native path",
    () => {
      const bytes = randomBytes(FIVE_MB);
      const reference = Buffer.from(bytes).toString("base64");
      expect(bytesToBase64(bytes) === reference).toBe(true);
    },
  );

  it("matches Buffer through the default path", () => {
    const bytes = randomBytes(FIVE_MB + 1);
    expect(bytesToBase64(bytes) === Buffer.from(bytes).toString("base64")).toBe(true);
  });

  it("encodes every length near a chunk boundary", () => {
    for (const length of [0, 1, 2, 3, 4, 24575, 24576, 24577, 49152, 49153]) {
      const bytes = randomBytes(length);
      const reference = Buffer.from(bytes).toString("base64");
      expect(bytesToBase64Fallback(bytes)).toBe(reference);
      expect(bytesToBase64(bytes)).toBe(reference);
      expect(base64DecodedLength(reference)).toBe(length);
    }
  });

  it("accepts an ArrayBuffer", () => {
    expect(bytesToBase64(new Uint8Array([1, 2, 3]).buffer)).toBe("AQID");
  });

  it("decodes standard padded base64 and refuses other text", () => {
    expect(Array.from(base64ToBytes("AQID") ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(base64ToBytes("AQI=") ?? [])).toEqual([1, 2]);
    for (const bad of ["AQI", "AQ-D", "AQ_D", "A QID", "AQID\n", "====", "AQ=D"]) {
      expect(base64ToBytes(bad)).toBeNull();
      expect(base64ToBytesFallback(bad)).toBeNull();
      expect(isBase64(bad)).toBe(false);
    }
  });
});

describe("hex and utf8", () => {
  it("encodes hex like Buffer", () => {
    const bytes = randomBytes(1000);
    expect(bytesToHex(bytes)).toBe(Buffer.from(bytes).toString("hex"));
    expect(bytesToHex(new Uint8Array([0, 15, 255]).buffer)).toBe("000fff");
  });

  it("counts UTF-8 bytes like TextEncoder", () => {
    for (const text of ["", "abc", "Zoë", "€", "日本語", "😀 ok", "\ud800 lone"]) {
      expect(utf8ByteLength(text)).toBe(utf8(text).length);
    }
  });
});
