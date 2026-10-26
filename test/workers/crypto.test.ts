import { describe, expect, it } from "vitest";
import {
  CredentialDecryptError,
  createKeyRing,
  decrypt,
  encrypt,
  needsReencrypt,
} from "../../src/crypto/index";

describe("key ring (workerd)", () => {
  it("encrypts, decrypts, and rotates in the Workers runtime", async () => {
    const old = createKeyRing({
      keys: [{ version: 1, secret: new Uint8Array(32).fill(9) }],
      current: 1,
    });
    const envelope = await encrypt(old, "secret value", ["app", "7"]);
    expect(envelope.startsWith("ms1.1.")).toBe(true);

    const ring = createKeyRing({
      keys: [
        { version: 1, secret: new Uint8Array(32).fill(9) },
        { version: 2, secret: crypto.getRandomValues(new Uint8Array(32)) },
      ],
      current: 2,
    });
    expect(await decrypt(ring, envelope, ["app", "7"])).toBe("secret value");
    expect(needsReencrypt(ring, envelope)).toBe(true);
    const fresh = await encrypt(ring, "secret value", ["app", "7"]);
    expect(needsReencrypt(ring, fresh)).toBe(false);
    await expect(decrypt(ring, fresh, ["app", "8"])).rejects.toBeInstanceOf(CredentialDecryptError);
  });
});
