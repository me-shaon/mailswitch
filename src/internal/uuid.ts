// A UUID derived from a key, for providers that take an idempotency key only as a UUID.
// The same key always gives the same UUID.

import { bytesToHex, utf8 } from "./encoding";

/**
 * Hashes `key` with SHA-256 and formats the first 16 bytes as an RFC 9562 version 8
 * UUID: the version nibble is 8 and the variant bits are `10`. The text is lowercase.
 * https://www.rfc-editor.org/rfc/rfc9562#name-uuid-version-8
 */
export async function uuidFromKey(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(key)), 0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
