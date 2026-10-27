import { describe, expect, it } from "vitest";
import { derToRawSignature, ecdsaP256Verify } from "../../src/internal/ecdsa";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const DATA = utf8('1700000000[{"event":"delivered"}]');

/** A minimal DER INTEGER: leading zero bytes dropped, and `0x00` added for a high bit. */
function derInteger(value: Uint8Array): number[] {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const bytes = [...value.subarray(start)];
  if ((bytes[0] as number) & 0x80) bytes.unshift(0);
  return [0x02, bytes.length, ...bytes];
}

/** Encodes a raw `r||s` signature as DER, the form that providers send. */
function toDer(raw: Uint8Array): Uint8Array {
  const body = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

async function p256(): Promise<{ key: CryptoKeyPair; spki: string }> {
  const key = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = bytesToBase64(
    new Uint8Array((await crypto.subtle.exportKey("spki", key.publicKey)) as ArrayBuffer),
  );
  return { key, spki };
}

async function sign(key: CryptoKeyPair, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(SIGN, key.privateKey, data));
}

describe("derToRawSignature", () => {
  it("round-trips a raw signature through DER", () => {
    const raw = crypto.getRandomValues(new Uint8Array(64));
    raw[0] = 0x7f;
    raw[32] = 0x01;
    expect(derToRawSignature(toDer(raw))).toEqual(raw);
  });

  it("strips the leading 0x00 of a 33-byte integer", () => {
    const raw = new Uint8Array(64).fill(0xab);
    const der = toDer(raw);
    expect(der[3]).toBe(33);
    expect(der.length).toBe(72);
    expect(derToRawSignature(der)).toEqual(raw);
  });

  it("left-pads a 31-byte integer to 32 bytes", () => {
    const raw = new Uint8Array(64).fill(0x11);
    raw[0] = 0;
    raw[32] = 0;
    raw[33] = 0;
    const der = toDer(raw);
    expect(der[3]).toBe(31);
    expect(derToRawSignature(der)).toEqual(raw);
  });

  it("returns null for a truncated value, a wrong tag, and a long integer", () => {
    const der = toDer(new Uint8Array(64).fill(0x42));
    expect(derToRawSignature(new Uint8Array(0))).toBeNull();
    for (let length = 1; length < der.length; length++) {
      expect(derToRawSignature(der.subarray(0, length))).toBeNull();
    }
    const wrongSequence = der.slice();
    wrongSequence[0] = 0x31;
    expect(derToRawSignature(wrongSequence)).toBeNull();
    const wrongInteger = der.slice();
    wrongInteger[2] = 0x03;
    expect(derToRawSignature(wrongInteger)).toBeNull();
    const r34 = [0x02, 34, 0, 0, ...new Uint8Array(32).fill(1)];
    const s = derInteger(new Uint8Array(32).fill(1));
    expect(
      derToRawSignature(Uint8Array.from([0x30, r34.length + s.length, ...r34, ...s])),
    ).toBeNull();
  });

  it("returns null for trailing bytes, a missing s, an empty integer, and a 33-byte integer without 0x00", () => {
    const der = toDer(new Uint8Array(64).fill(0x42));
    const trailing = Uint8Array.from([...der, 0]);
    trailing[1] = (trailing[1] as number) + 1;
    expect(derToRawSignature(trailing)).toBeNull();
    const r = derInteger(new Uint8Array(32).fill(0x42));
    expect(derToRawSignature(Uint8Array.from([0x30, r.length, ...r]))).toBeNull();
    const empty = [0x02, 0];
    expect(
      derToRawSignature(Uint8Array.from([0x30, empty.length + r.length, ...empty, ...r])),
    ).toBeNull();
    const noZero = [0x02, 33, ...new Uint8Array(33).fill(1)];
    expect(
      derToRawSignature(Uint8Array.from([0x30, noZero.length + r.length, ...noZero, ...r])),
    ).toBeNull();
    // An integer length that runs past the end of the sequence.
    const past = Uint8Array.from([0x30, 6, 0x02, 1, 1, 0x02, 5, 1]);
    expect(derToRawSignature(past)).toBeNull();
  });

  it("returns null for a long-form length", () => {
    const der = toDer(new Uint8Array(64).fill(0x42));
    const long = Uint8Array.from([0x30, 0x81, der.length - 2, ...der.subarray(2)]);
    expect(derToRawSignature(long)).toBeNull();
  });
});

describe("ecdsaP256Verify", () => {
  it("verifies Web Crypto signatures after a DER round trip", async () => {
    const { key, spki } = await p256();
    // Twenty signatures cover r and s values with and without the high bit.
    for (let i = 0; i < 20; i++) {
      const data = utf8(`${i}:${new TextDecoder().decode(DATA)}`);
      expect(await ecdsaP256Verify(spki, toDer(await sign(key, data)), data)).toBe(true);
    }
  });

  it("accepts a key with whitespace around it, and uses the cached key again", async () => {
    const { key, spki } = await p256();
    const signature = toDer(await sign(key, DATA));
    expect(await ecdsaP256Verify(` ${spki}\n`, signature, DATA)).toBe(true);
    expect(await ecdsaP256Verify(spki, signature, DATA)).toBe(true);
  });

  it("returns false for tampered data, a tampered signature, and another key", async () => {
    const { key, spki } = await p256();
    const other = await p256();
    const raw = await sign(key, DATA);
    const signature = toDer(raw);
    expect(await ecdsaP256Verify(spki, signature, utf8("tampered"))).toBe(false);
    const tampered = raw.slice();
    tampered[63] = (tampered[63] as number) ^ 1;
    expect(await ecdsaP256Verify(spki, toDer(tampered), DATA)).toBe(false);
    expect(await ecdsaP256Verify(other.spki, signature, DATA)).toBe(false);
  });

  it("returns false for a raw signature or bad DER, without a throw", async () => {
    const { key, spki } = await p256();
    const raw = await sign(key, DATA);
    expect(await ecdsaP256Verify(spki, raw, DATA)).toBe(false);
    expect(await ecdsaP256Verify(spki, new Uint8Array(0), DATA)).toBe(false);
  });

  it("returns false for a key that is not base64, not SPKI, or for another curve", async () => {
    const { key } = await p256();
    const signature = toDer(await sign(key, DATA));
    const p384 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const p384Spki = bytesToBase64(
      new Uint8Array((await crypto.subtle.exportKey("spki", p384.publicKey)) as ArrayBuffer),
    );
    expect(await ecdsaP256Verify(p384Spki, signature, DATA)).toBe(false);
    // A second call takes the path after the failed import left the cache.
    expect(await ecdsaP256Verify(p384Spki, signature, DATA)).toBe(false);
    expect(await ecdsaP256Verify("not base64!", signature, DATA)).toBe(false);
    expect(await ecdsaP256Verify("", signature, DATA)).toBe(false);
    expect(await ecdsaP256Verify(bytesToBase64(utf8("not a key")), signature, DATA)).toBe(false);
  });

  it("keeps working after the key cache fills", async () => {
    const pairs = await Promise.all(Array.from({ length: 34 }, () => p256()));
    for (const { key, spki } of pairs) {
      expect(await ecdsaP256Verify(spki, toDer(await sign(key, DATA)), DATA)).toBe(true);
    }
    const first = pairs[0] as { key: CryptoKeyPair; spki: string };
    expect(await ecdsaP256Verify(first.spki, toDer(await sign(first.key, DATA)), DATA)).toBe(true);
  });
});
