// mailswitch/crypto: a key ring that encrypts provider credentials at rest.
//
// Cipher: AES-256-GCM through Web Crypto, with a random 96-bit nonce per value.
// Key: HKDF-SHA-256 over the secret of each key version. The info is the fixed text
// `mailswitch/credentials/v1`. The salt is `mailswitch/credentials/key/<version>`, so one
// secret reused under two versions still gives two different keys.
//
// Envelope: `ms1.<keyVersion>.<nonce>.<ciphertext>`. The key version is a decimal
// integer. The nonce and the ciphertext (with the 16-byte GCM tag at its end) are
// unpadded base64url.
//
// Additional data: a length-prefixed encoding of the format (`ms1`), the key version, and
// each entry of the app scope. Each item is a 4-byte big-endian byte length and the UTF-8
// bytes, after a 4-byte item count. So the scopes ["a:b","c"] and ["a","b:c"] give
// different additional data, and an envelope moved to another scope does not decrypt.
//
// This subpath is standalone. It does not import the core.

import { base64ToBytes, bytesToBase64, utf8 } from "../internal/encoding";

const FORMAT = "ms1";
const HKDF_INFO = "mailswitch/credentials/v1";
const SALT_PREFIX = "mailswitch/credentials/key/";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_SECRET_BYTES = 32;
const VERSION_PATTERN = /^[1-9][0-9]{0,14}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** One key of a ring. */
export interface KeyRingKey {
  /** A positive integer. Each version in a ring is unique. */
  version: number;
  /** At least 32 bytes: raw bytes, or the bytes as padded, standard-alphabet base64 text. */
  secret: string | Uint8Array;
}

/** Options of `createKeyRing`. */
export interface KeyRingOptions {
  keys: readonly KeyRingKey[];
  /** The version that `encrypt` uses. It must be in `keys`. */
  current: number;
}

/** A key ring. Pass it to `encrypt`, `decrypt`, and `needsReencrypt`. */
export interface KeyRing {
  /** The version that `encrypt` uses. */
  readonly current: number;
  /** Every version in the ring, in ascending order. */
  readonly versions: readonly number[];
}

/** Why `decrypt` failed. */
export type CredentialDecryptErrorCode = "format" | "unknown_version" | "auth_failed";

const MESSAGES: Readonly<Record<CredentialDecryptErrorCode, string>> = {
  format: "The encrypted credentials are not a valid mailswitch envelope.",
  unknown_version: "The key version of the encrypted credentials is not in the key ring.",
  auth_failed: "The encrypted credentials do not decrypt with this key and scope.",
};

/**
 * A decryption failure. The message is fixed for each code. It never contains the
 * envelope, the plaintext, or the scope.
 */
export class CredentialDecryptError extends Error {
  readonly code: CredentialDecryptErrorCode;
  constructor(code: CredentialDecryptErrorCode) {
    super(MESSAGES[code]);
    this.name = "CredentialDecryptError";
    this.code = code;
  }
}

interface RingState {
  secrets: Map<number, Uint8Array<ArrayBuffer>>;
  keys: Map<number, Promise<CryptoKey>>;
}

const states = new WeakMap<KeyRing, RingState>();

function secretBytes(secret: unknown, version: number): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  if (typeof secret === "string") bytes = base64ToBytes(secret.trim());
  else if (secret instanceof Uint8Array) bytes = new Uint8Array(secret);
  if (!bytes) {
    throw new TypeError(
      `createKeyRing: the secret of version ${version} must be bytes or base64 text.`,
    );
  }
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new RangeError(
      `createKeyRing: the secret of version ${version} is shorter than ${MIN_SECRET_BYTES} bytes.`,
    );
  }
  return bytes;
}

/**
 * Creates a key ring. It throws for a programmer error: no keys, a version that is not a
 * positive integer, a duplicate version, a secret shorter than 32 bytes, or a `current`
 * version that is not in the ring. Error messages never contain a secret.
 */
export function createKeyRing(options: KeyRingOptions): KeyRing {
  const list = options?.keys;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError("createKeyRing: keys must be a non-empty array.");
  }
  const secrets = new Map<number, Uint8Array<ArrayBuffer>>();
  for (const key of list as readonly KeyRingKey[]) {
    const version = key?.version;
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new RangeError("createKeyRing: a key version must be a positive integer.");
    }
    if (secrets.has(version)) {
      throw new RangeError(`createKeyRing: version ${version} is in the ring more than once.`);
    }
    secrets.set(version, secretBytes(key.secret, version));
  }
  if (!secrets.has(options.current)) {
    throw new RangeError("createKeyRing: the current version is not in the ring.");
  }
  const ring: KeyRing = Object.freeze({
    current: options.current,
    versions: Object.freeze([...secrets.keys()].sort((a, b) => a - b)),
  });
  states.set(ring, { secrets, keys: new Map() });
  return ring;
}

function stateOf(ring: KeyRing): RingState {
  const state = states.get(ring);
  if (!state) throw new TypeError("mailswitch/crypto: use a key ring from createKeyRing.");
  return state;
}

/** Derives the AES key of one version once, and caches it on the ring. */
function aesKey(state: RingState, version: number): Promise<CryptoKey> {
  let key = state.keys.get(version);
  if (!key) {
    const secret = state.secrets.get(version) as Uint8Array<ArrayBuffer>;
    key = crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]).then((material) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: utf8(`${SALT_PREFIX}${version}`),
          info: utf8(HKDF_INFO),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
    // Drop a failed derivation, so a later call can try again.
    key.catch(() => state.keys.delete(version));
    state.keys.set(version, key);
  }
  return key;
}

function checkScope(scope: readonly string[]): void {
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new TypeError("mailswitch/crypto: scope must be a non-empty array of strings.");
  }
  for (const item of scope) {
    if (typeof item !== "string") {
      throw new TypeError("mailswitch/crypto: scope must be a non-empty array of strings.");
    }
  }
}

/** The additional data: an item count, then each item as a 4-byte length and its bytes. */
function additionalData(version: number, scope: readonly string[]): Uint8Array<ArrayBuffer> {
  const items = [FORMAT, String(version), ...scope].map(utf8);
  let length = 4;
  for (const item of items) length += 4 + item.length;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, items.length);
  let offset = 4;
  for (const item of items) {
    view.setUint32(offset, item.length);
    out.set(item, offset + 4);
    offset += 4 + item.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bytes = base64ToBytes(padded);
  // Refuse a non-canonical encoding, so one envelope has exactly one spelling.
  if (!bytes || toBase64Url(bytes) !== text) return null;
  return bytes;
}

interface Envelope {
  version: number;
  nonce: Uint8Array<ArrayBuffer>;
  sealed: Uint8Array<ArrayBuffer>;
}

function parseEnvelope(envelope: string): Envelope {
  const parts = typeof envelope === "string" ? envelope.split(".") : [];
  const [format, versionText, nonceText, sealedText] = parts;
  if (parts.length !== 4 || format !== FORMAT || !VERSION_PATTERN.test(versionText ?? "")) {
    throw new CredentialDecryptError("format");
  }
  const nonce = fromBase64Url(nonceText ?? "");
  const sealed = fromBase64Url(sealedText ?? "");
  if (!nonce || nonce.length !== NONCE_BYTES || !sealed || sealed.length < TAG_BYTES) {
    throw new CredentialDecryptError("format");
  }
  return { version: Number(versionText), nonce, sealed };
}

/**
 * Encrypts a value with the current key of the ring and binds it to `scope`. The scope
 * names what the value belongs to, for example `["workspace", "42", "resend"]`. An empty
 * scope is a programmer error and throws.
 */
export async function encrypt(
  ring: KeyRing,
  plaintext: string,
  scope: readonly string[],
): Promise<string> {
  const state = stateOf(ring);
  checkScope(scope);
  if (typeof plaintext !== "string") {
    throw new TypeError("mailswitch/crypto: plaintext must be a string.");
  }
  const version = ring.current;
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: additionalData(version, scope) },
    await aesKey(state, version),
    utf8(plaintext),
  );
  return `${FORMAT}.${version}.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(sealed))}`;
}

/**
 * Decrypts an envelope from `encrypt` with the same scope. A failure throws a
 * `CredentialDecryptError` with code `format`, `unknown_version`, or `auth_failed`.
 * This is not a provider failure, so it throws instead of returning a result. An empty
 * scope is a programmer error and throws a TypeError.
 */
export async function decrypt(
  ring: KeyRing,
  envelope: string,
  scope: readonly string[],
): Promise<string> {
  const state = stateOf(ring);
  checkScope(scope);
  const parsed = parseEnvelope(envelope);
  if (!state.secrets.has(parsed.version)) throw new CredentialDecryptError("unknown_version");
  const key = await aesKey(state, parsed.version);
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: parsed.nonce,
        additionalData: additionalData(parsed.version, scope),
      },
      key,
      parsed.sealed,
    );
  } catch {
    throw new CredentialDecryptError("auth_failed");
  }
  return new TextDecoder().decode(opened);
}

/**
 * True when the envelope uses a key version other than the current one. Decrypt the value
 * and encrypt it again to move it to the current key. A value that is not an envelope
 * throws a `CredentialDecryptError` with code `format`.
 */
export function needsReencrypt(ring: KeyRing, envelope: string): boolean {
  stateOf(ring);
  return parseEnvelope(envelope).version !== ring.current;
}
