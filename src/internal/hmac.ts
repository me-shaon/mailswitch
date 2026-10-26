// HMAC helpers on Web Crypto. Verification uses `crypto.subtle.verify`, which compares in
// constant time on every runtime.

import { bytesToHex, utf8 } from "./encoding";

/** The hash functions that the HMAC helpers accept. */
export type HmacHash = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

/** An HMAC secret: text (encoded as UTF-8), raw bytes, or an imported `CryptoKey`. */
export type HmacKey = string | Uint8Array | CryptoKey;

const MAX_CACHED_KEYS = 32;

// The cache key is a SHA-256 digest of the secret, so raw secrets are not kept as map keys.
const keyCache: Map<string, Promise<CryptoKey>> = new Map();

async function importKey(key: HmacKey, hash: HmacHash): Promise<CryptoKey> {
  if (typeof key !== "string" && !(key instanceof Uint8Array)) return key;
  const raw = typeof key === "string" ? utf8(key) : key;
  const digest = await crypto.subtle.digest("SHA-256", raw);
  const cacheKey = `${hash}:${bytesToHex(digest)}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const imported = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash }, false, [
    "sign",
    "verify",
  ]);
  if (keyCache.size >= MAX_CACHED_KEYS) keyCache.clear();
  keyCache.set(cacheKey, imported);
  imported.catch(() => keyCache.delete(cacheKey));
  return imported;
}

/** Signs `data` with HMAC. Returns the raw signature bytes. */
export async function hmacSign(
  key: HmacKey,
  data: Uint8Array,
  hash: HmacHash = "SHA-256",
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await importKey(key, hash);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

/**
 * Checks an HMAC signature over `data` in constant time. Returns false for a wrong
 * signature, including one of the wrong length.
 */
export async function hmacVerify(
  key: HmacKey,
  signature: Uint8Array,
  data: Uint8Array,
  hash: HmacHash = "SHA-256",
): Promise<boolean> {
  const cryptoKey = await importKey(key, hash);
  return crypto.subtle.verify("HMAC", cryptoKey, signature, data);
}
