import { describe, expect, it } from "vitest";
import { bytesToHex, utf8 } from "../../src/internal/encoding";
import { sha256Hex } from "../../src/internal/sha256";

async function reference(data: Uint8Array): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", data));
}

describe("sha256Hex", () => {
  it("matches the FIPS test vectors", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(utf8("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches Web Crypto at every padding boundary", async () => {
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(data), `length ${length}`).toBe(await reference(data));
    }
  });
});
