// ECDSA P-256 with SHA-256 on Web Crypto, for webhooks that a provider signs with a
// private key. Web Crypto takes the raw `r||s` form of a signature, and providers send
// DER, so this module also converts DER to raw. The exported functions never throw.

import { base64ToBytes } from "./encoding";

const SEQUENCE = 0x30;
const INTEGER = 0x02;
/** The byte length of `r` and of `s` for P-256. */
const SIZE = 32;
const MAX_CACHED_KEYS = 32;

// The cache key is the trimmed base64 key text. A public key is not a secret, so it can be a
// map key, and a cache hit needs no decode and no digest.
const keyCache: Map<string, Promise<CryptoKey>> = new Map();

/**
 * Reads one DER INTEGER at `at` into `out` at `offset`, left-padded to 32 bytes. Returns
 * the end offset, or -1 for a wrong tag, a long-form length, an empty integer, or an
 * integer that does not fit in 32 bytes after one leading `0x00` is stripped.
 */
function integer(der: Uint8Array, at: number, out: Uint8Array, offset: number): number {
  const length = der[at + 1] ?? 0;
  const end = at + 2 + length;
  if (der[at] !== INTEGER || length === 0 || length > SIZE + 1 || end > der.length) return -1;
  let start = at + 2;
  if (length === SIZE + 1) {
    if (der[start] !== 0) return -1;
    start++;
  }
  out.set(der.subarray(start, end), offset + SIZE - (end - start));
  return end;
}

/**
 * Converts a DER `SEQUENCE { INTEGER r, INTEGER s }` to the 64-byte `r||s` form. Returns
 * null for a truncated value, a wrong tag, trailing bytes, or an integer longer than 33
 * bytes. A P-256 signature is at most 72 bytes, so only the short length form is valid.
 */
export function derToRawSignature(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der[0] !== SEQUENCE || der[1] !== der.length - 2) return null;
  const raw = new Uint8Array(SIZE * 2);
  const middle = integer(der, 2, raw, 0);
  if (middle < 0) return null;
  return integer(der, middle, raw, SIZE) === der.length ? raw : null;
}

async function importKey(spki: string): Promise<CryptoKey | null> {
  const cacheKey = spki.trim();
  let imported = keyCache.get(cacheKey);
  if (!imported) {
    const bytes = base64ToBytes(cacheKey);
    if (bytes === null) return null;
    imported = crypto.subtle.importKey(
      "spki",
      bytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    if (keyCache.size >= MAX_CACHED_KEYS) keyCache.clear();
    keyCache.set(cacheKey, imported);
    imported.catch(() => keyCache.delete(cacheKey));
  }
  return imported.catch(() => null);
}

/**
 * Checks an ECDSA P-256 signature with SHA-256 over `data`. `publicKey` is a base64
 * SubjectPublicKeyInfo, and `signature` is DER. Returns false for a key that is not
 * base64 or not a P-256 key, a signature that is not valid DER, and a wrong signature.
 */
export async function ecdsaP256Verify(
  publicKey: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const raw = derToRawSignature(signature);
  if (raw === null) return false;
  const key = await importKey(publicKey);
  if (key === null) return false;
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, data);
  } catch {
    return false;
  }
}
