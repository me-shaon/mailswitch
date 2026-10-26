// A minimal DER reader: just enough to take the public key out of an X.509 certificate,
// so Web Crypto can import it as SPKI. Workers have no X.509 API. The exported functions
// return null for bad input and never throw.

import { base64ToBytes } from "../../internal/encoding";

const SEQUENCE = 0x30;
const EXPLICIT_VERSION = 0xa0;
const PEM = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/;

/**
 * Reads the element at `at`: its tag, the offset of its content, and its end offset.
 * It throws a RangeError for a truncated element or one that runs past `limit`. Only
 * `certificateSpki` calls it, and it catches the error.
 */
function element(bytes: Uint8Array, at: number, limit: number): [number, number, number] {
  const tag = bytes[at];
  let length = bytes[at + 1] ?? Number.NaN;
  let cursor = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new RangeError("DER: unsupported length.");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (bytes[cursor++] ?? Number.NaN);
  }
  const end = cursor + length;
  if (tag === undefined || !(end <= limit)) throw new RangeError("DER: truncated element.");
  return [tag, cursor, end];
}

/** The DER bytes of the first certificate in a PEM text, or null. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> | null {
  const body = PEM.exec(pem)?.[1];
  if (body === undefined) return null;
  return base64ToBytes(body.replace(/\s+/g, ""));
}

/**
 * The SubjectPublicKeyInfo of a certificate, or null. Certificate is SEQUENCE {
 * tbsCertificate, signatureAlgorithm, signature }, and tbsCertificate is SEQUENCE {
 * [0] version (optional), serialNumber, signature, issuer, validity, subject,
 * subjectPublicKeyInfo, ... }.
 */
export function certificateSpki(der: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  try {
    const [certTag, certStart, certEnd] = element(der, 0, der.length);
    const [tbsTag, tbsStart, tbsEnd] = element(der, certStart, certEnd);
    if (certTag !== SEQUENCE || tbsTag !== SEQUENCE) return null;
    let at = tbsStart;
    if (der[at] === EXPLICIT_VERSION) at = element(der, at, tbsEnd)[2];
    // Skip serialNumber, signature, issuer, validity, and subject.
    for (let i = 0; i < 5; i++) at = element(der, at, tbsEnd)[2];
    const [tag, , end] = element(der, at, tbsEnd);
    return tag === SEQUENCE ? der.slice(at, end) : null;
  } catch {
    return null;
  }
}
