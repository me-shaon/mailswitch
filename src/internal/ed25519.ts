// Ed25519 on Web Crypto, for webhooks that a provider signs with an Ed25519 private key.
// The public key is SubjectPublicKeyInfo, as base64 or as a `PUBLIC KEY` PEM block. The
// exported function never throws.

import { base64ToBytes } from "./encoding";

const MAX_CACHED_KEYS = 32;
const PEM = /^-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----$/;

// The cache key is the trimmed key text. A public key is not a secret, so it can be a map
// key, and a cache hit needs no decode.
const keyCache: Map<string, Promise<CryptoKey>> = new Map();

/** The SPKI bytes of a base64 or PEM key text, or null for any other text. */
function spkiBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!text.includes("-----")) return base64ToBytes(text);
  const body = PEM.exec(text)?.[1];
  return body === undefined ? null : base64ToBytes(body.replace(/\s+/g, ""));
}

async function importKey(publicKey: string): Promise<CryptoKey | null> {
  const cacheKey = publicKey.trim();
  let imported = keyCache.get(cacheKey);
  if (!imported) {
    const bytes = spkiBytes(cacheKey);
    if (bytes === null || bytes.length === 0) return null;
    imported = crypto.subtle.importKey("spki", bytes, { name: "Ed25519" }, false, ["verify"]);
    if (keyCache.size >= MAX_CACHED_KEYS) keyCache.clear();
    keyCache.set(cacheKey, imported);
    imported.catch(() => keyCache.delete(cacheKey));
  }
  return imported.catch(() => null);
}

/**
 * Checks an Ed25519 signature over `data`. `publicKey` is a base64 SubjectPublicKeyInfo or
 * a `PUBLIC KEY` PEM block, and `signature` is the raw 64-byte form. Returns false for a
 * key that is not base64, a PEM block of another type, a key that is not Ed25519, and a
 * wrong signature.
 */
export async function ed25519Verify(
  publicKey: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const key = await importKey(publicKey);
  if (key === null) return false;
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
  } catch {
    return false;
  }
}
