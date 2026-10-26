import { describe, expect, it } from "vitest";
import {
  CredentialDecryptError,
  createKeyRing,
  decrypt,
  encrypt,
  needsReencrypt,
} from "../../src/crypto/index";
import { bytesToBase64 } from "../../src/internal/encoding";

const SECRET_1 = bytesToBase64(new Uint8Array(32).fill(1));
const SECRET_2 = new Uint8Array(32).fill(2);
const PLAINTEXT = '{"apiKey":"re_live_secret_value_123"}';
const SCOPE = ["workspace", "42", "resend"];

const v1 = () => createKeyRing({ keys: [{ version: 1, secret: SECRET_1 }], current: 1 });
const v1v2 = () =>
  createKeyRing({
    keys: [
      { version: 1, secret: SECRET_1 },
      { version: 2, secret: SECRET_2 },
    ],
    current: 2,
  });

async function failure(promise: Promise<unknown>): Promise<CredentialDecryptError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialDecryptError);
    return error as CredentialDecryptError;
  }
  throw new Error("expected a CredentialDecryptError");
}

function expectSafe(error: Error, envelope: string): void {
  const [, , nonce = "", sealed = ""] = envelope.split(".");
  for (const text of [error.message, String(error), JSON.stringify(error)]) {
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain("re_live");
    expect(text).not.toContain(envelope);
    expect(text).not.toContain(nonce);
    expect(text).not.toContain(sealed);
  }
}

describe("key ring", () => {
  it("round-trips a value in the ms1 envelope format", async () => {
    const ring = v1();
    const envelope = await encrypt(ring, PLAINTEXT, SCOPE);
    expect(envelope).toMatch(/^ms1\.1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(envelope).not.toContain(PLAINTEXT);
    expect(await decrypt(ring, envelope, SCOPE)).toBe(PLAINTEXT);
    // A fresh nonce each time.
    expect(await encrypt(ring, PLAINTEXT, SCOPE)).not.toBe(envelope);
    expect(await decrypt(ring, await encrypt(ring, "", SCOPE), SCOPE)).toBe("");
  });

  it("fails when the envelope moves to another scope", async () => {
    const ring = v1();
    const envelope = await encrypt(ring, PLAINTEXT, SCOPE);
    const error = await failure(decrypt(ring, envelope, ["workspace", "43", "resend"]));
    expect(error.code).toBe("auth_failed");
    expectSafe(error, envelope);
  });

  it("keeps scope entries apart: ['a:b','c'] and ['a','b:c'] do not cross-decrypt", async () => {
    const ring = v1();
    const one = await encrypt(ring, PLAINTEXT, ["a:b", "c"]);
    const two = await encrypt(ring, PLAINTEXT, ["a", "b:c"]);
    expect((await failure(decrypt(ring, one, ["a", "b:c"]))).code).toBe("auth_failed");
    expect((await failure(decrypt(ring, two, ["a:b", "c"]))).code).toBe("auth_failed");
    expect((await failure(decrypt(ring, one, ["a:bc"]))).code).toBe("auth_failed");
    expect(await decrypt(ring, one, ["a:b", "c"])).toBe(PLAINTEXT);
  });

  it("fails for a tampered version field", async () => {
    const ring = v1v2();
    const envelope = await encrypt(ring, PLAINTEXT, SCOPE);
    const tampered = envelope.replace(/^ms1\.2\./, "ms1.1.");
    const error = await failure(decrypt(ring, tampered, SCOPE));
    expect(error.code).toBe("auth_failed");
    expectSafe(error, tampered);
    const padded = envelope.replace(/^ms1\.2\./, "ms1.02.");
    expect((await failure(decrypt(ring, padded, SCOPE))).code).toBe("format");
  });

  it("fails for a truncated tag", async () => {
    const ring = v1();
    const envelope = await encrypt(ring, PLAINTEXT, SCOPE);
    const truncated = envelope.slice(0, -4);
    const error = await failure(decrypt(ring, truncated, SCOPE));
    expect(["auth_failed", "format"]).toContain(error.code);
    expectSafe(error, truncated);
    const [format, version, nonce] = envelope.split(".");
    const short = `${format}.${version}.${nonce}.AAAAAAAAAAAAAAAAAAAA`;
    expect((await failure(decrypt(ring, short, SCOPE))).code).toBe("format");
  });

  it("fails for an unknown version", async () => {
    const envelope = await encrypt(v1v2(), PLAINTEXT, SCOPE);
    const error = await failure(decrypt(v1(), envelope, SCOPE));
    expect(error.code).toBe("unknown_version");
    expectSafe(error, envelope);
  });

  it("refuses malformed envelopes with a format error", async () => {
    const ring = v1();
    for (const bad of ["", "ms1", "ms2.1.AAAA.AAAA", "ms1.1.AA+A.AAAA", "ms1.0.AAAA.AAAA"]) {
      expect((await failure(decrypt(ring, bad, SCOPE))).code).toBe("format");
    }
  });

  it("decrypts version 1 and encrypts with version 2 during rotation", async () => {
    const old = await encrypt(v1(), PLAINTEXT, SCOPE);
    const ring = v1v2();
    expect(await decrypt(ring, old, SCOPE)).toBe(PLAINTEXT);
    const fresh = await encrypt(ring, PLAINTEXT, SCOPE);
    expect(fresh.startsWith("ms1.2.")).toBe(true);
    expect(needsReencrypt(ring, old)).toBe(true);
    expect(needsReencrypt(ring, fresh)).toBe(false);
    expect(ring.versions).toEqual([1, 2]);
    expect(ring.current).toBe(2);
  });

  it("gives different keys to one secret under two versions", async () => {
    const a = createKeyRing({ keys: [{ version: 1, secret: SECRET_1 }], current: 1 });
    const b = createKeyRing({ keys: [{ version: 2, secret: SECRET_1 }], current: 2 });
    const envelope = (await encrypt(a, PLAINTEXT, SCOPE)).replace(/^ms1\.1\./, "ms1.2.");
    expect((await failure(decrypt(b, envelope, SCOPE))).code).toBe("auth_failed");
  });

  it("throws for duplicate versions", () => {
    expect(() =>
      createKeyRing({
        keys: [
          { version: 1, secret: SECRET_1 },
          { version: 1, secret: SECRET_2 },
        ],
        current: 1,
      }),
    ).toThrow(/more than once/);
  });

  it("throws for a 16-byte secret", () => {
    const short = bytesToBase64(new Uint8Array(16).fill(7));
    expect(() =>
      createKeyRing({ keys: [{ version: 1, secret: new Uint8Array(16) }], current: 1 }),
    ).toThrow(/32 bytes/);
    let message = "";
    try {
      createKeyRing({ keys: [{ version: 1, secret: short }], current: 1 });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/32 bytes/);
    expect(message).not.toContain(short);
  });

  it("throws for other programmer errors in the ring", () => {
    const one = [{ version: 1, secret: SECRET_1 }];
    expect(() => createKeyRing({ keys: one, current: 2 })).toThrow(/current/);
    expect(() => createKeyRing({ keys: [], current: 1 })).toThrow(TypeError);
    expect(() => createKeyRing({ keys: [{ version: 0, secret: SECRET_1 }], current: 0 })).toThrow(
      /positive integer/,
    );
    expect(() =>
      createKeyRing({ keys: [{ version: 1, secret: "not base64!" }], current: 1 }),
    ).toThrow(TypeError);
  });

  it("throws a TypeError for an empty scope", async () => {
    const ring = v1();
    await expect(encrypt(ring, PLAINTEXT, [])).rejects.toThrow(TypeError);
    const envelope = await encrypt(ring, PLAINTEXT, SCOPE);
    await expect(decrypt(ring, envelope, [])).rejects.toThrow(TypeError);
  });

  it("refuses a ring that createKeyRing did not make", async () => {
    await expect(encrypt({ current: 1, versions: [1] }, PLAINTEXT, SCOPE)).rejects.toThrow(
      TypeError,
    );
  });
});
