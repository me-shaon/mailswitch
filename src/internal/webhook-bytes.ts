// Shared by the webhook verifiers. These helpers live in their own module so that code
// which does not verify webhooks does not carry them.

import { utf8 } from "./encoding";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Decodes bytes as strict UTF-8 and parses them as JSON. It never throws. It returns
 * `undefined` for bytes that are not valid JSON text. `JSON.parse` never returns `undefined`,
 * so that value is a safe marker.
 */
export function decodeJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strictUtf8.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** Decodes hex text of either case. Returns null for an odd length or a non-hex character. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
}

/**
 * Compares two texts in constant time. It hashes both with SHA-256 and compares the two
 * 32-byte digests with a fixed-length loop, so the time does not depend on where the
 * texts differ and does not reveal their length.
 */
export async function timingSafeEqualText(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}
