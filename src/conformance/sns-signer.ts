// A test stand-in for Amazon SNS: an RSA key, a certificate in PEM form that holds its
// public key, and a signer for SNS messages. A verifier reads only the public key from
// the certificate (it trusts the HTTPS host), so the certificate needs no real issuer.

import { bytesToBase64, utf8 } from "../internal/encoding";
import { type SnsMessage, snsStringToSign } from "../providers/ses/sns-fields";

export type { SnsMessage };

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array | number[]): Uint8Array {
  const body = content instanceof Uint8Array ? [...content] : content;
  return new Uint8Array([tag, ...derLength(body.length), ...body]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

const SHA256_WITH_RSA = der(0x30, [
  ...der(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
  0x05,
  0x00,
]);

/** A minimal X.509 v3 certificate around a SubjectPublicKeyInfo. */
function certificate(spki: Uint8Array): string {
  const time = der(0x17, [...utf8("260101000000Z")]);
  const tbs = der(
    0x30,
    concat(
      der(0xa0, der(0x02, [0x02])),
      der(0x02, [0x01]),
      SHA256_WITH_RSA,
      der(0x30, []),
      der(0x30, concat(time, time)),
      der(0x30, []),
      spki,
    ),
  );
  const cert = der(0x30, concat(tbs, SHA256_WITH_RSA, der(0x03, [0x00, 0x01])));
  const base64 = bytesToBase64(cert).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

/** A test signer for SNS messages. */
export interface SnsSigner {
  /** The PEM certificate to serve at `SigningCertURL`. */
  certificatePem: string;
  /** Fills `Signature` and `SignatureVersion` of a message. */
  sign(message: Omit<SnsMessage, "Signature">, version?: "1" | "2"): Promise<SnsMessage>;
}

/** Creates a new RSA key and a signer that uses it. */
export async function createSnsSigner(): Promise<SnsSigner> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const sha1Key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return {
    certificatePem: certificate(spki),
    async sign(message, version = "2") {
      const unsigned = { ...message, SignatureVersion: version, Signature: "" } as SnsMessage;
      const key = version === "2" ? pair.privateKey : sha1Key;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        utf8(snsStringToSign(unsigned)),
      );
      return { ...unsigned, Signature: bytesToBase64(signature) };
    },
  };
}
