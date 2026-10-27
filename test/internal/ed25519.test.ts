import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519Verify } from "../../src/internal/ed25519";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";

const DATA = utf8('"@method": POST\n"@signature-params": ("@method");created=1700000000');

async function ed25519(): Promise<{ key: CryptoKeyPair; spki: string }> {
  const key = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = bytesToBase64(
    new Uint8Array((await crypto.subtle.exportKey("spki", key.publicKey)) as ArrayBuffer),
  );
  return { key, spki };
}

async function sign(key: CryptoKeyPair, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, data));
}

/** Wraps base64 key text in PEM armor, with 64-character lines. */
function pem(spki: string, label = "PUBLIC KEY"): string {
  const lines = spki.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ed25519Verify", () => {
  it("verifies a signature made with a key pair from Web Crypto", async () => {
    const { key, spki } = await ed25519();
    expect(await ed25519Verify(spki, await sign(key, DATA), DATA)).toBe(true);
  });

  it("accepts a PEM block and a key with whitespace around it", async () => {
    const { key, spki } = await ed25519();
    const signature = await sign(key, DATA);
    expect(await ed25519Verify(pem(spki), signature, DATA)).toBe(true);
    expect(await ed25519Verify(pem(spki).replace(/\n/g, "\r\n"), signature, DATA)).toBe(true);
    expect(await ed25519Verify(` ${spki}\n`, signature, DATA)).toBe(true);
  });

  it("imports the same key text once", async () => {
    const { key, spki } = await ed25519();
    const signature = await sign(key, DATA);
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    expect(await ed25519Verify(spki, signature, DATA)).toBe(true);
    expect(await ed25519Verify(spki, signature, DATA)).toBe(true);
    expect(await ed25519Verify(`${spki}\n`, signature, DATA)).toBe(true);
    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it("returns false for a changed message, a changed signature, and another key", async () => {
    const { key, spki } = await ed25519();
    const other = await ed25519();
    const signature = await sign(key, DATA);
    expect(await ed25519Verify(spki, signature, utf8("tampered"))).toBe(false);
    const tampered = signature.slice();
    tampered[63] = (tampered[63] as number) ^ 1;
    expect(await ed25519Verify(spki, tampered, DATA)).toBe(false);
    expect(await ed25519Verify(other.spki, signature, DATA)).toBe(false);
  });

  it("returns false for a signature with the wrong length, without a throw", async () => {
    const { key, spki } = await ed25519();
    const signature = await sign(key, DATA);
    expect(await ed25519Verify(spki, new Uint8Array(0), DATA)).toBe(false);
    expect(await ed25519Verify(spki, signature.subarray(0, 63), DATA)).toBe(false);
    expect(await ed25519Verify(spki, Uint8Array.from([...signature, 0]), DATA)).toBe(false);
  });

  it("returns false for a key that is not base64, a PEM block of another type, or not Ed25519", async () => {
    const { key, spki } = await ed25519();
    const signature = await sign(key, DATA);
    const p256 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const p256Spki = bytesToBase64(
      new Uint8Array((await crypto.subtle.exportKey("spki", p256.publicKey)) as ArrayBuffer),
    );
    expect(await ed25519Verify("not base64!", signature, DATA)).toBe(false);
    expect(await ed25519Verify("", signature, DATA)).toBe(false);
    expect(await ed25519Verify(pem(spki, "CERTIFICATE"), signature, DATA)).toBe(false);
    expect(await ed25519Verify(pem(spki, "PRIVATE KEY"), signature, DATA)).toBe(false);
    expect(await ed25519Verify(`${pem(spki)}${pem(spki)}`, signature, DATA)).toBe(false);
    expect(await ed25519Verify("-----BEGIN PUBLIC KEY-----", signature, DATA)).toBe(false);
    expect(await ed25519Verify(bytesToBase64(utf8("not a key")), signature, DATA)).toBe(false);
    expect(await ed25519Verify(p256Spki, signature, DATA)).toBe(false);
    // A second call takes the path after the failed import left the cache.
    expect(await ed25519Verify(p256Spki, signature, DATA)).toBe(false);
  });

  it("keeps working after the key cache fills", async () => {
    const pairs = await Promise.all(Array.from({ length: 34 }, () => ed25519()));
    for (const { key, spki } of pairs) {
      expect(await ed25519Verify(spki, await sign(key, DATA), DATA)).toBe(true);
    }
    const first = pairs[0] as { key: CryptoKeyPair; spki: string };
    expect(await ed25519Verify(first.spki, await sign(first.key, DATA), DATA)).toBe(true);
  });
});
