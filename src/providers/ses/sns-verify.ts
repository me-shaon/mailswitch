// Amazon SNS message signatures (SignatureVersion 1 and 2).
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html
//
// SNS signs a canonical string of some message fields with the private key of the
// certificate at `SigningCertURL`. The certificate is trusted because it comes over
// HTTPS from an SNS host, so the URL check is the security boundary. A valid signature
// proves only that some SNS topic sent the message. Anyone can subscribe this endpoint
// to their own topic, so the topic allowlist is required and is checked before any
// certificate fetch.

import type { WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import { base64ToBytes, utf8 } from "../../internal/encoding";
import { type FetchLike, readCapped } from "../../internal/http";
import { certificateSpki, pemToDer } from "./der";
import { isSnsMessageType, type SnsMessage, snsStringToSign } from "./sns-fields";

/** The oldest `Timestamp` that verification accepts by default: 1 hour. */
export const SNS_MAX_AGE_MS: number = 60 * 60 * 1000;
/** How far in the future a `Timestamp` can be, for clock skew: 5 minutes. */
export const SNS_MAX_FUTURE_MS: number = 5 * 60 * 1000;
/** How long a fetched certificate stays in the cache: 24 hours. */
export const SNS_CERT_TTL_MS: number = 24 * 60 * 60 * 1000;
/** The default timeout of a certificate fetch. */
export const SNS_CERT_TIMEOUT_MS: number = 5000;
/** The largest certificate response that verification reads. */
export const SNS_CERT_MAX_BYTES: number = 16 * 1024;

const TOPIC_ARN =
  /^arn:(aws|aws-cn|aws-us-gov):sns:([a-z]{2}(?:-[a-z]+)+-\d{1,2}):\d{12}:[A-Za-z0-9_-]{1,256}(?:\.fifo)?$/;
const CERT_PATH = /^\/SimpleNotificationService-[A-Za-z0-9]{1,64}\.pem$/;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Parses an SNS body. Returns null when it is not an SNS message. */
export function parseSnsMessage(body: Uint8Array): SnsMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch {
    return null;
  }
  if (!isSnsShape(value)) return null;
  // A message without SignatureVersion is version 1.
  return { ...value, SignatureVersion: String(value.SignatureVersion ?? "1") };
}

/** True when a parsed body has the required string fields and a known message type. */
function isSnsShape(value: unknown): value is SnsMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  // isSnsMessageType checks the Type field.
  for (const field of [
    "MessageId",
    "TopicArn",
    "Message",
    "Timestamp",
    "Signature",
    "SigningCertURL",
  ]) {
    if (typeof message[field] !== "string") return false;
  }
  return isSnsMessageType(message.Type);
}

/** The parts of an SNS topic ARN. */
export interface TopicArn {
  partition: string;
  region: string;
}

/** Parses an SNS topic ARN, or returns null. */
export function parseTopicArn(arn: string): TopicArn | null {
  const match = TOPIC_ARN.exec(arn);
  if (!match) return null;
  return {
    partition: match[1] as string,
    region: match[2] as string,
  };
}

/** The SNS host of a topic: `sns.<region>.amazonaws.com`, or `.com.cn` in China. */
export function snsHost(topic: TopicArn): string {
  return `sns.${topic.region}.amazonaws.com${topic.partition === "aws-cn" ? ".cn" : ""}`;
}

function snsUrl(value: string, topic: TopicArn): URL | null {
  // The origin covers the scheme, the host, and any port that is not 443.
  const url = URL.parse(value);
  return url?.origin === `https://${snsHost(topic)}` && url.username + url.password === ""
    ? url
    : null;
}

/**
 * True when a URL is a signing certificate of the SNS host of the topic region: https,
 * no port, no user info, no query, and a `.pem` path.
 */
export function isSnsCertUrl(value: string, topic: TopicArn): boolean {
  const url = snsUrl(value, topic);
  return url !== null && url.search === "" && url.hash === "" && CERT_PATH.test(url.pathname);
}

/** True when a `SubscribeURL` points at the SNS host of the topic region. */
export function isSnsSubscribeUrl(value: string, topic: TopicArn): boolean {
  const url = snsUrl(value, topic);
  return url !== null && url.searchParams.get("Action") === "ConfirmSubscription";
}

/**
 * Reads the topic allowlist: topic ARNs separated by commas. An entry that is not a
 * valid topic ARN is ignored, so it matches nothing.
 */
export function parseTopicAllowlist(text: string): Set<string> {
  const set = new Set<string>();
  for (const item of text.split(",")) {
    const arn = item.trim();
    if (parseTopicArn(arn)) set.add(arn);
  }
  return set;
}

/** Options of the SNS verifier. */
export interface SnsVerifyOptions {
  /** The oldest `Timestamp` to accept, in milliseconds. Defaults to 1 hour. */
  snsMaxAgeMs?: number;
  /** Refuse SignatureVersion 1 (SHA-1). Recommended: set the topic to version 2 first. */
  requireSignatureVersion2?: boolean;
  /** The timeout of a certificate fetch, in milliseconds. Defaults to 5 seconds. */
  certTimeoutMs?: number;
  /** The largest certificate response, in bytes. Defaults to 16 KiB. */
  maxCertBytes?: number;
}

interface CertKeys {
  "SHA-1": CryptoKey;
  "SHA-256": CryptoKey;
}

interface CacheEntry {
  expiresAt: number;
  keys: Promise<CertKeys | null>;
}

const MAX_CACHED_CERTS = 32;

/**
 * Creates an SNS webhook verifier with its own certificate cache. `input.secret` is the
 * topic allowlist: one or more topic ARNs, separated by commas. Checks, in order:
 *
 * 1. The body is an SNS message, and the `x-amz-sns-message-type` header matches it.
 * 2. The signature version is 1 or 2 (only 2 with `requireSignatureVersion2`).
 * 3. The topic is on the allowlist (`untrusted_topic`). No fetch happens before this.
 * 4. The `Timestamp` is at most `snsMaxAgeMs` old and at most 5 minutes ahead (`stale`).
 * 5. The certificate URL is an SNS host of the topic region, then the signature.
 *
 * Certificates are cached per URL for 24 hours. A failed fetch is not cached. Requests
 * that arrive during a fetch share it.
 *
 * @throws TypeError for an invalid option.
 */
export function createSnsVerifier(
  options: SnsVerifyOptions = {},
): (input: WebhookVerifyInput) => Promise<WebhookVerifyResult> {
  for (const name of ["snsMaxAgeMs", "certTimeoutMs", "maxCertBytes"] as const) {
    const value = options[name];
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
      throw new TypeError(`ses: ${name} must be a positive number.`);
    }
  }
  const maxAgeMs = options.snsMaxAgeMs ?? SNS_MAX_AGE_MS;
  const timeoutMs = options.certTimeoutMs ?? SNS_CERT_TIMEOUT_MS;
  const maxBytes = options.maxCertBytes ?? SNS_CERT_MAX_BYTES;
  const requireV2 = options.requireSignatureVersion2 === true;
  const cache = new Map<string, CacheEntry>();

  async function fetchKeys(url: string, fetcher: FetchLike): Promise<CertKeys | null> {
    try {
      // The fetch never follows a redirect, so the certificate comes only from the checked
      // host. Workers refuse `redirect: "error"`, so "manual" plus a 200-only rule does
      // the same job: any 3xx is a failure.
      const response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200 || response.redirected) return null;
      const pem = await readCapped(response, maxBytes);
      const der = pem === null ? null : pemToDer(pem);
      const spki = der === null ? null : certificateSpki(der);
      if (spki === null) return null;
      const load = (hash: "SHA-1" | "SHA-256") =>
        crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, [
          "verify",
        ]);
      return { "SHA-1": await load("SHA-1"), "SHA-256": await load("SHA-256") };
    } catch {
      return null;
    }
  }

  function keysFor(url: string, now: number, fetcher: FetchLike): Promise<CertKeys | null> {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now) return cached.keys;
    if (cache.size >= MAX_CACHED_CERTS) cache.clear();
    const entry: CacheEntry = { expiresAt: now + SNS_CERT_TTL_MS, keys: fetchKeys(url, fetcher) };
    cache.set(url, entry);
    // A failure is not cached, so the next message tries again.
    void entry.keys.then((keys) => {
      if (keys === null && cache.get(url) === entry) cache.delete(url);
    });
    return entry.keys;
  }

  return async function verifySns(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
    const message = parseSnsMessage(input.body);
    if (!message) return { ok: false, reason: "malformed" };
    if (input.headers.get("x-amz-sns-message-type") !== message.Type) {
      return { ok: false, reason: "malformed" };
    }
    const version = message.SignatureVersion;
    if (version !== "2" && (version !== "1" || requireV2)) {
      return { ok: false, reason: "bad_signature" };
    }
    const topic = parseTopicArn(message.TopicArn);
    if (!topic || !parseTopicAllowlist(input.secret).has(message.TopicArn)) {
      return { ok: false, reason: "untrusted_topic" };
    }
    const at = Date.parse(message.Timestamp);
    if (!Number.isFinite(at)) return { ok: false, reason: "malformed" };
    if (input.now - at > maxAgeMs || at - input.now > SNS_MAX_FUTURE_MS) {
      return { ok: false, reason: "stale" };
    }
    if (!isSnsCertUrl(message.SigningCertURL, topic)) return { ok: false, reason: "bad_signature" };
    const canonical = snsStringToSign(message);
    const signature = base64ToBytes(message.Signature);
    if (canonical === "") return { ok: false, reason: "malformed" };
    if (!signature) return { ok: false, reason: "bad_signature" };
    const fetcher: FetchLike = input.fetch ?? ((url, init) => fetch(url, init));
    const keys = await keysFor(message.SigningCertURL, input.now, fetcher);
    if (!keys) return { ok: false, reason: "bad_signature" };
    const key = keys[version === "2" ? "SHA-256" : "SHA-1"];
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, utf8(canonical));
    return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
  };
}
