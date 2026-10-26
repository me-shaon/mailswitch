import { describe, expect, it } from "vitest";
import { hmacSign, hmacVerify } from "../../src/internal/hmac";
import { bytesToHex, utf8 } from "../../src/provider-kit/index";

// RFC 4231 test case 2.
const KEY = "Jefe";
const DATA = utf8("what do ya want for nothing?");
const SHA256 = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

describe("hmac", () => {
  it("matches the RFC 4231 vector", async () => {
    expect(bytesToHex(await hmacSign(KEY, DATA))).toBe(SHA256);
    expect(bytesToHex(await hmacSign(utf8(KEY), DATA, "SHA-256"))).toBe(SHA256);
  });

  it("accepts a valid signature", async () => {
    const signature = await hmacSign(KEY, DATA);
    expect(await hmacVerify(KEY, signature, DATA)).toBe(true);
    expect(await hmacVerify(utf8(KEY), signature, DATA)).toBe(true);
  });

  it("rejects a tampered signature, tampered data, a wrong key, and a short signature", async () => {
    const signature = await hmacSign(KEY, DATA);
    const tampered = signature.slice();
    tampered[0] = (tampered[0] as number) ^ 1;
    expect(await hmacVerify(KEY, tampered, DATA)).toBe(false);
    expect(await hmacVerify(KEY, signature, utf8("what do ya want for nothing!"))).toBe(false);
    expect(await hmacVerify("Jeff", signature, DATA)).toBe(false);
    expect(await hmacVerify(KEY, signature.slice(0, 16), DATA)).toBe(false);
  });

  it("accepts a CryptoKey", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      utf8(KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const signature = await hmacSign(key, DATA);
    expect(bytesToHex(signature)).toBe(SHA256);
    expect(await hmacVerify(key, signature, DATA)).toBe(true);
  });

  it("keeps keys for different hashes apart", async () => {
    const sha1 = await hmacSign(KEY, DATA, "SHA-1");
    expect(bytesToHex(sha1)).toBe("effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    expect(await hmacVerify(KEY, sha1, DATA, "SHA-1")).toBe(true);
    expect(await hmacVerify(KEY, sha1, DATA, "SHA-256")).toBe(false);
  });
});
