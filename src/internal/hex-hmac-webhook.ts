// The signature check that the Mailtrap and AutoSend webhooks share: one header with the
// hex HMAC-SHA256 of the raw body.

import { hmacVerify } from "./hmac";
import { hexToBytes } from "./webhook-bytes";

const SIGNATURE = /^[0-9a-f]{64}$/i;

/**
 * Checks a hex HMAC-SHA256 signature header over the raw body. Returns the refusal
 * reason, or undefined when the signature is valid.
 *
 * - An empty secret, a missing header, and a signature that does not match are
 *   `bad_signature`.
 * - A header that is not 64 hex characters after a trim is `malformed`.
 */
export async function checkHexHmac(
  secret: string,
  headers: Headers,
  header: string,
  body: Uint8Array,
): Promise<"bad_signature" | "malformed" | undefined> {
  if (secret === "") return "bad_signature";
  const value = headers.get(header);
  if (value === null) return "bad_signature";
  const hex = value.trim();
  if (!SIGNATURE.test(hex)) return "malformed";
  // The pattern above makes the decode succeed.
  const signature = hexToBytes(hex) as Uint8Array<ArrayBuffer>;
  return (await hmacVerify(secret, signature, body)) ? undefined : "bad_signature";
}
