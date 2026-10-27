// The private key import of the fixtures that sign with a key pair. The keys are fixed
// test values, so an app test can put the public key in a static binding.

import { base64ToBytes } from "../../internal/encoding";

const cache = new Map<string, Promise<CryptoKey>>();

/** Imports one PKCS #8 private key on first use, and keeps it for later calls. */
export function importPrivateKey(
  pkcs8: string,
  algorithm: Parameters<typeof crypto.subtle.importKey>[2],
): Promise<CryptoKey> {
  let key = cache.get(pkcs8);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      "pkcs8",
      base64ToBytes(pkcs8) as Uint8Array<ArrayBuffer>,
      algorithm,
      false,
      ["sign"],
    );
    cache.set(pkcs8, key);
  }
  return key;
}
