// MailChannels webhooks. MailChannels signs each request with Ed25519, as HTTP Message
// Signatures (RFC 9421) over the `Content-Digest` header. Checked 2026-10-27.
// https://docs.mailchannels.com/email-api/webhooks
// https://docs.mailchannels.com/email-api/webhook-schema
// https://docs.mailchannels.com/email-api/webhook-event-types
// https://docs.mailchannels.com/api-reference/webhooks/retrieve-webhook-signing-key
//
// A request carries three headers:
//
//   Content-Digest: sha-256=:<base64 SHA-256 of the body>:
//   Signature-Input: sig_1=("content-digest");created=<unix>;alg="ed25519";keyid="mckey"
//   Signature: sig_1=:<base64 Ed25519 signature>:
//
// The signature base is two lines with no trailing newline:
//
//   "content-digest": <the Content-Digest value>
//   "@signature-params": <the Signature-Input text after the label and "=">
//
// The webhook secret is the public key that MailChannels serves for the `keyid`, as a
// base64 SubjectPublicKeyInfo or a PEM block. The signature covers `created`, so an old
// request is refused as stale. A retry gets a new signature, so the webhook router must
// dedupe the events.
//
// The docs do not say that the signing key is unique to one account. So a valid
// signature does not prove that the request is for your account, and every event must
// carry your `customer_handle`. A body with any other handle, or with no handle, is
// refused.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { bounceDetail } from "../../internal/bounce-detail";
import { ed25519Verify } from "../../internal/ed25519";
import { base64ToBytes, bytesToBase64, isBase64, utf8 } from "../../internal/encoding";
import { asRecord, stringField } from "../../internal/json";
import { decodeJsonBytes } from "../../internal/webhook-bytes";

/** The digest header of a MailChannels webhook request. */
export const MAILCHANNELS_DIGEST_HEADER = "content-digest";
/** The header that describes the signature. */
export const MAILCHANNELS_SIGNATURE_INPUT_HEADER = "signature-input";
/** The header that holds the signature. */
export const MAILCHANNELS_SIGNATURE_HEADER = "signature";
/** How old a `created` time can be, in milliseconds. */
export const MAILCHANNELS_WEBHOOK_TOLERANCE_MS: number = 5 * 60 * 1000;
/** How far a `created` time can be in the future, for clock skew, in milliseconds. */
export const MAILCHANNELS_WEBHOOK_FUTURE_SKEW_MS: number = 60 * 1000;
/** The most events that one MailChannels request holds. */
export const MAILCHANNELS_MAX_WEBHOOK_EVENTS = 1000;

const COMPONENTS = '("content-digest")';
const KEY = "[a-z*][a-z0-9_.*-]*";
const LABELLED = new RegExp(`^(${KEY})=(.*)$`, "s");
const BYTE_SEQUENCE = new RegExp(`^(${KEY})=:([A-Za-z0-9+/]*={0,2}):$`);
// One parameter: a key, then a string, an integer, a decimal, a token, or a boolean. A
// bare key is a true boolean.
const PARAM = new RegExp(
  `^;\\s*(${KEY})(?:=("(?:[^"\\\\\\x00-\\x1f\\x7f]|\\\\["\\\\])*"|-?\\d{1,15}(?:\\.\\d{1,3})?|[A-Za-z*][A-Za-z0-9!#$%&'*+.^_\`|~:/-]*|\\?[01]))?`,
);
const INTEGER = /^\d{1,12}$/;

/** The bytes that MailChannels signs, from the two header texts. */
export function mailchannelsSignatureBase(
  contentDigest: string,
  signatureParams: string,
): Uint8Array {
  return utf8(`"content-digest": ${contentDigest}\n"@signature-params": ${signatureParams}`);
}

/** The `Content-Digest` value of a body: `sha-256=:<base64>:`. */
export async function mailchannelsContentDigest(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>);
  return `sha-256=:${bytesToBase64(new Uint8Array(digest))}:`;
}

/**
 * Reads the public key text. It accepts base64 and a `PUBLIC KEY` PEM block, with the
 * armor lines and the white space removed. The armor of any other label stays in the
 * text, so the base64 check refuses it. Returns null when the key is not base64.
 */
function keyText(secret: string): string | null {
  const text = secret.replace(/-----(?:BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  return isBase64(text) ? text : null;
}

interface SignatureInput {
  label: string;
  /** The text after `label=`, exactly as sent. */
  params: string;
  created: number;
  expires?: number;
}

/**
 * Parses `Signature-Input`. It must hold one signature that covers exactly
 * `("content-digest")`, with an integer `created` and `alg="ed25519"`. A repeated
 * parameter is refused. Returns null for any other text.
 */
function parseSignatureInput(header: string): SignatureInput | null {
  const match = LABELLED.exec(header.trim());
  if (!match) return null;
  const label = match[1] as string;
  const params = match[2] as string;
  if (!params.startsWith(COMPONENTS)) return null;
  const values = new Map<string, string>();
  let rest = params.slice(COMPONENTS.length);
  while (rest !== "") {
    const param = PARAM.exec(rest);
    if (!param) return null;
    const key = param[1] as string;
    if (values.has(key)) return null;
    values.set(key, param[2] ?? "?1");
    rest = rest.slice(param[0].length);
  }
  const created = values.get("created");
  const expires = values.get("expires");
  const keyid = values.get("keyid");
  if (created === undefined || !INTEGER.test(created)) return null;
  if (values.get("alg") !== '"ed25519"') return null;
  if (keyid !== undefined && !keyid.startsWith('"')) return null;
  if (expires !== undefined && !INTEGER.test(expires)) return null;
  return {
    label,
    params,
    created: Number(created),
    ...(expires === undefined ? {} : { expires: Number(expires) }),
  };
}

/** Parses a `Signature` header with one member. Returns the label and the bytes. */
function parseSignature(header: string): { label: string; bytes: Uint8Array } | null {
  const match = BYTE_SEQUENCE.exec(header.trim());
  const bytes = match ? base64ToBytes(match[2] as string) : null;
  if (!match || bytes === null || bytes.length !== 64) return null;
  return { label: match[1] as string, bytes };
}

/**
 * The base64 value of the `sha-256` entry of `Content-Digest`. Returns null for a header
 * that cannot be parsed, a repeated entry, or no `sha-256` entry.
 */
function sha256Entry(header: string): string | null {
  const seen = new Set<string>();
  let value: string | null = null;
  for (const member of header.split(",")) {
    const match = BYTE_SEQUENCE.exec(member.trim());
    if (!match) return null;
    const key = match[1] as string;
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === "sha-256") value = match[2] as string;
  }
  return value;
}

/** Throws unless the customer handle is a non-blank string. */
function checkHandle(customerHandle: unknown): string {
  if (typeof customerHandle !== "string" || customerHandle.trim() === "") {
    throw new TypeError("The MailChannels webhooks need the customerHandle option.");
  }
  return customerHandle.trim();
}

/** True when every entry is an event that carries this customer handle. */
function ownEvents(events: unknown[], customerHandle: string): boolean {
  return events.every((item) => asRecord(item)?.customer_handle === customerHandle);
}

/**
 * The `webhooks.verify` method of the MailChannels adapter. An empty secret and a missing
 * header are refused as `bad_signature`. So is a signed body with an event whose
 * `customer_handle` is missing or is not `customerHandle`. A header that cannot be parsed, a label that
 * differs between the two signature headers, a covered component other than
 * `content-digest`, and a missing or other `alg` are `malformed`. A `created` time more
 * than 5 minutes old, or more than 1 minute in the future, is `stale`. A secret that is
 * not base64 is `invalid_secret`, because that is a setup error on this side.
 *
 * @throws TypeError when `customerHandle` is blank. That is a programmer error.
 */
export async function verifyMailchannelsWebhook(
  input: WebhookVerifyInput,
  customerHandle: string,
): Promise<WebhookVerifyResult> {
  const handle = checkHandle(customerHandle);
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const key = keyText(input.secret);
  if (key === null) return { ok: false, reason: "invalid_secret" };
  const digestHeader = input.headers.get(MAILCHANNELS_DIGEST_HEADER);
  const inputHeader = input.headers.get(MAILCHANNELS_SIGNATURE_INPUT_HEADER);
  const signatureHeader = input.headers.get(MAILCHANNELS_SIGNATURE_HEADER);
  if (!digestHeader || !inputHeader || !signatureHeader) {
    return { ok: false, reason: "bad_signature" };
  }
  const parsed = parseSignatureInput(inputHeader);
  const signature = parseSignature(signatureHeader);
  const expected = sha256Entry(digestHeader);
  if (parsed === null || signature === null || expected === null) {
    return { ok: false, reason: "malformed" };
  }
  if (signature.label !== parsed.label) return { ok: false, reason: "malformed" };
  const base = mailchannelsSignatureBase(digestHeader, parsed.params);
  if (!(await ed25519Verify(key, signature.bytes, base))) {
    return { ok: false, reason: "bad_signature" };
  }
  // The signed digest must match the raw body bytes. The digest is not a secret, so a
  // plain comparison is enough.
  const actual = (await mailchannelsContentDigest(input.body)).slice("sha-256=:".length, -1);
  if (actual !== expected) {
    return { ok: false, reason: "bad_signature" };
  }
  // A replayed request carries its old `created` time, and the signature covers it.
  const created = parsed.created * 1000;
  if (
    input.now - created > MAILCHANNELS_WEBHOOK_TOLERANCE_MS ||
    created - input.now > MAILCHANNELS_WEBHOOK_FUTURE_SKEW_MS ||
    (parsed.expires !== undefined && input.now > parsed.expires * 1000)
  ) {
    return { ok: false, reason: "stale" };
  }
  const value = decodeJsonBytes(input.body);
  if (!Array.isArray(value) || value.length > MAILCHANNELS_MAX_WEBHOOK_EVENTS) {
    return { ok: false, reason: "malformed" };
  }
  // A valid signature from another account is still not a request for this account.
  return ownEvents(value, handle) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  delivered: "delivered",
  "hard-bounced": "bounced",
  "soft-bounced": "bounced",
  complained: "complained",
  unsubscribed: "unsubscribed",
};

/** The recipient addresses of an event. An entry is an address or an object with `email`. */
function recipientsOf(record: Record<string, unknown>): string[] {
  const list = record.recipients;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const email =
      typeof item === "string" ? item.trim() : stringField(asRecord(item) ?? {}, "email");
    if (email) out.push(email);
  }
  return out;
}

/**
 * Parses a verified MailChannels body. One body is a JSON array of up to 1000 events.
 *
 * - `delivered` maps to `delivered`. `hard-bounced` and `soft-bounced` map to `bounced`,
 *   `hard` and `soft`. `complained` maps to `complained`. `unsubscribed` maps to
 *   `unsubscribed`. Every other event, such as `processed`, `dropped`, `open`, or `test`,
 *   gives `unknown`.
 * - `email` is the sender, so `recipient` comes from `recipients`, and only when the
 *   event names exactly one recipient.
 * - An event carries `request_id` and no message id, so `providerMessageId` is not set.
 * - MailChannels gives no event id. The event key joins `request_id`, the event name, the
 *   sorted recipients, `timestamp`, and the `url` of a click.
 * - A body with any entry whose `customer_handle` is missing or is not `customerHandle`
 *   gives no events.
 *
 * @throws TypeError when `customerHandle` is blank.
 */
export function parseMailchannelsEvents(
  provider: string,
  body: Uint8Array,
  customerHandle: string,
): NormalizedEvent[] {
  const handle = checkHandle(customerHandle);
  const value = decodeJsonBytes(body);
  if (!Array.isArray(value) || !ownEvents(value, handle)) return [];
  const out: NormalizedEvent[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const rawType = stringField(record, "event") ?? "unknown";
    const type = TYPES[rawType] ?? "unknown";
    const recipients = recipientsOf(record);
    const seconds = record.timestamp;
    const eventKey = [
      stringField(record, "request_id") ?? "",
      rawType,
      recipients
        .map((email) => email.toLowerCase())
        .sort()
        .join(","),
      typeof seconds === "number" || typeof seconds === "string" ? String(seconds) : "",
      stringField(record, "url") ?? "",
    ].join(":");
    const event: NormalizedEvent = { type, provider, eventKey, rawType };
    if (type === "bounced") {
      event.bounce = rawType === "hard-bounced" ? "hard" : "soft";
      // The MailChannels docs do not list these field names, so both stay optional.
      const detail = bounceDetail({ text: record.reason, enhancedCode: record.status });
      if (detail !== undefined) event.bounceDetail = detail;
    }
    if (recipients.length === 1) event.recipient = recipients[0] as string;
    if (typeof seconds === "number" && Number.isFinite(seconds)) event.occurredAt = seconds * 1000;
    out.push(event);
  }
  return out;
}

/**
 * The webhook methods of the MailChannels adapter. With no `customerHandle`, the methods
 * throw a `TypeError` when they are called. Sending does not need the handle.
 */
export function mailchannelsWebhooks(provider: string, customerHandle?: string): ProviderWebhooks {
  return {
    verify: (input) => verifyMailchannelsWebhook(input, customerHandle as string),
    parse: (body) => parseMailchannelsEvents(provider, body, customerHandle as string),
    signedTimestamp: true,
  };
}
