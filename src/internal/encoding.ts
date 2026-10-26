// Byte helpers on Web APIs only. No Node.js APIs, so the same code runs on Workers,
// Node, Bun, and Deno.

type NativeToBase64 = (this: Uint8Array) => string;
type NativeFromBase64 = (text: string, options?: { lastChunkHandling?: "strict" }) => Uint8Array;

const nativeToBase64: NativeToBase64 | undefined = (
  Uint8Array.prototype as unknown as { toBase64?: NativeToBase64 }
).toBase64;
const nativeFromBase64: NativeFromBase64 | undefined = (
  Uint8Array as unknown as { fromBase64?: NativeFromBase64 }
).fromBase64;

/** True when the runtime has `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64`. */
export const hasNativeBase64: boolean =
  typeof nativeToBase64 === "function" && typeof nativeFromBase64 === "function";

const encoder = new TextEncoder();

/** Encodes text as UTF-8 bytes. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

/** The UTF-8 byte length of a string, without encoding it. Lone surrogates count as 3 bytes. */
export function utf8ByteLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i++;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

/** The length of the padded base64 text for `byteLength` bytes. */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/** The number of bytes that a padded base64 string decodes to. It does not validate the text. */
export function base64DecodedLength(text: string): number {
  let padding = 0;
  if (text.endsWith("==")) padding = 2;
  else if (text.endsWith("=")) padding = 1;
  return (text.length / 4) * 3 - padding;
}

// A flat character class, so the check stays linear and does not recurse on large input.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** True for padded, standard-alphabet base64 with no whitespace. */
export function isBase64(text: string): boolean {
  return text.length % 4 === 0 && BASE64_PATTERN.test(text);
}

const ALPHABET: Uint8Array = utf8(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
);
const PAD = 0x3d;
const asciiDecoder = new TextDecoder();

/**
 * Encodes bytes as padded base64 without the native API. Exported for tests.
 *
 * It writes the ASCII codes into one byte array and decodes that once, so no string grows
 * per byte. This is about three times faster than `String.fromCharCode` chunks with `btoa`.
 */
export function bytesToBase64Fallback(bytes: Uint8Array): string {
  const length = bytes.length;
  const out = new Uint8Array(base64Length(length));
  const whole = length - (length % 3);
  let i = 0;
  let j = 0;
  for (; i < whole; i += 3, j += 4) {
    const triple =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out[j] = ALPHABET[triple >>> 18] as number;
    out[j + 1] = ALPHABET[(triple >>> 12) & 63] as number;
    out[j + 2] = ALPHABET[(triple >>> 6) & 63] as number;
    out[j + 3] = ALPHABET[triple & 63] as number;
  }
  if (i < length) {
    const second = i + 1 < length;
    const triple = ((bytes[i] as number) << 16) | (second ? (bytes[i + 1] as number) << 8 : 0);
    out[j] = ALPHABET[triple >>> 18] as number;
    out[j + 1] = ALPHABET[(triple >>> 12) & 63] as number;
    out[j + 2] = second ? (ALPHABET[(triple >>> 6) & 63] as number) : PAD;
    out[j + 3] = PAD;
  }
  return asciiDecoder.decode(out);
}

/** Encodes bytes as padded, standard-alphabet base64. */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (nativeToBase64) return nativeToBase64.call(view);
  return bytesToBase64Fallback(view);
}

/** Decodes padded base64 without the native API. Returns null for invalid text. Exported for tests. */
export function base64ToBytesFallback(text: string): Uint8Array<ArrayBuffer> | null {
  if (!isBase64(text)) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes padded, standard-alphabet base64. Returns null for invalid text. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!nativeFromBase64) return base64ToBytesFallback(text);
  if (!isBase64(text)) return null;
  try {
    return nativeFromBase64(text, { lastChunkHandling: "strict" }) as Uint8Array<ArrayBuffer>;
  } catch {
    return null;
  }
}

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/** Encodes bytes as lowercase hex. */
export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parts = new Array<string>(view.length);
  for (let i = 0; i < view.length; i++) parts[i] = HEX[view[i] as number] as string;
  return parts.join("");
}
