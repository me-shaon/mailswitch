import { describe, expect, it } from "vitest";
import { derToRawSignature, ecdsaP256Verify } from "../../src/internal/ecdsa";
import {
  base64ToBytes,
  base64ToBytesFallback,
  bytesToBase64,
  bytesToBase64Fallback,
  hasNativeBase64,
  utf8,
} from "../../src/internal/encoding";
import { uuidFromKey } from "../../src/internal/uuid";

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

/** Encodes a raw `r||s` signature as minimal DER. */
function toDer(raw: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array): number[] => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    const bytes = [...value.subarray(start)];
    if ((bytes[0] as number) & 0x80) bytes.unshift(0);
    return [0x02, bytes.length, ...bytes];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

describe("ECDSA P-256 (workerd)", () => {
  it("verifies a Web Crypto signature after a DER round trip", async () => {
    const key = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const spki = bytesToBase64(
      new Uint8Array((await crypto.subtle.exportKey("spki", key.publicKey)) as ArrayBuffer),
    );
    for (let i = 0; i < 10; i++) {
      const data = utf8(`1700000000${i}[{"event":"delivered"}]`);
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, data),
      );
      expect(derToRawSignature(toDer(raw))).toEqual(raw);
      expect(await ecdsaP256Verify(spki, toDer(raw), data)).toBe(true);
      expect(await ecdsaP256Verify(spki, toDer(raw), utf8("tampered"))).toBe(false);
    }
  });

  it("returns false for a key that is not base64 or for another curve", async () => {
    const p384 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const spki = bytesToBase64(
      new Uint8Array((await crypto.subtle.exportKey("spki", p384.publicKey)) as ArrayBuffer),
    );
    const signature = toDer(new Uint8Array(64).fill(1));
    expect(await ecdsaP256Verify(spki, signature, utf8("x"))).toBe(false);
    expect(await ecdsaP256Verify("not base64!", signature, utf8("x"))).toBe(false);
  });
});

describe("uuidFromKey (workerd)", () => {
  it("gives the same version 8 UUID as Node for a known key", async () => {
    expect(await uuidFromKey("abc")).toBe("ba7816bf-8f01-8fea-8141-40de5dae2223");
    expect(await uuidFromKey("order-1")).not.toBe(await uuidFromKey("order-2"));
    expect(await uuidFromKey("order-1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
