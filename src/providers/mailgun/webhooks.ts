// Mailgun webhooks.
// https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks
// https://documentation.mailgun.com/docs/mailgun/user-manual/events/
//
// Mailgun posts one event per request as JSON: `{ "signature": {...}, "event-data": {...} }`.
// The signature is the hex HMAC-SHA256 of `timestamp + token`, under the HTTP webhook
// signing key. It does not cover `event-data`. So:
// - `verify` refuses a timestamp more than 5 minutes old or more than 1 minute ahead.
// - The event key is the token. The adapter marks its keys as bound to the body, so the
//   webhook router also claims the token together with the SHA-256 of the raw body. A
//   reused token with a different body is refused, and a same-body retry after the lease
//   expires is delivered again.
// - The dedupe store is required, and the dedupe TTL is at least twice the window.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { bounceDetail, cleanBounceText } from "../../internal/bounce-detail";
import { bytesToHex, utf8 } from "../../internal/encoding";
import { hmacSign, hmacVerify } from "../../internal/hmac";
import { decodeJsonBytes, hexToBytes } from "../../internal/webhook-bytes";

/** How old a signed timestamp can be, in milliseconds. */
export const MAILGUN_WEBHOOK_MAX_AGE_MS: number = 5 * 60 * 1000;
/** How far ahead of the clock a signed timestamp can be, in milliseconds. */
export const MAILGUN_WEBHOOK_MAX_SKEW_MS: number = 60 * 1000;
/** The shortest dedupe TTL for Mailgun: twice the timestamp window, in milliseconds. */
export const MAILGUN_MIN_DEDUPE_TTL_MS: number =
  2 * (MAILGUN_WEBHOOK_MAX_AGE_MS + MAILGUN_WEBHOOK_MAX_SKEW_MS);

const TIMESTAMP = /^\d{1,12}$/;
const TOKEN = /^[A-Za-z0-9]{1,200}$/;
const SIGNATURE = /^[0-9a-f]{64}$/i;

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

/** The hex signature of `timestamp + token`, as Mailgun computes it. */
export async function mailgunSignature(
  signingKey: string,
  timestamp: string,
  token: string,
): Promise<string> {
  return bytesToHex(await hmacSign(signingKey, utf8(`${timestamp}${token}`)));
}

interface SignatureFields {
  timestamp: string;
  token: string;
  signature: string;
}

/** Reads the signature object. Null when it is missing, a string when it is malformed. */
function readSignature(value: unknown): SignatureFields | null | "malformed" {
  const signature = record(record(value)?.signature);
  if (!signature) return null;
  const { timestamp, token, signature: hex } = signature;
  if (
    (typeof timestamp !== "string" && typeof timestamp !== "number") ||
    typeof token !== "string" ||
    typeof hex !== "string"
  ) {
    return null;
  }
  const stamp = String(timestamp);
  if (!TIMESTAMP.test(stamp) || !TOKEN.test(token) || !SIGNATURE.test(hex.trim())) {
    return "malformed";
  }
  return { timestamp: stamp, token, signature: hex.trim() };
}

/**
 * Checks a Mailgun webhook: a JSON content type, the HMAC of `timestamp + token`, and the
 * timestamp window. It never throws for a bad request. It cannot detect a changed
 * `event-data`. The router refuses a reused token with a different body.
 */
export async function verifyMailgunWebhook(
  input: WebhookVerifyInput,
): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const type = input.headers.get("content-type");
  if (type === null || !/^application\/json\s*(;|$)/i.test(type.trim())) {
    return { ok: false, reason: "malformed" };
  }
  const value = decodeJsonBytes(input.body);
  if (!record(value)) return { ok: false, reason: "malformed" };
  const signature = readSignature(value);
  if (signature === null) return { ok: false, reason: "bad_signature" };
  if (signature === "malformed") return { ok: false, reason: "malformed" };
  const signed = utf8(`${signature.timestamp}${signature.token}`);
  if (
    !(await hmacVerify(input.secret, hexToBytes(signature.signature) ?? new Uint8Array(0), signed))
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  const age = input.now - Number(signature.timestamp) * 1000;
  if (age > MAILGUN_WEBHOOK_MAX_AGE_MS || -age > MAILGUN_WEBHOOK_MAX_SKEW_MS) {
    return { ok: false, reason: "stale" };
  }
  if (!record((value as Fields)["event-data"])) return { ok: false, reason: "malformed" };
  return { ok: true };
}

function text(fields: Fields | undefined, name: string): string | undefined {
  const value = fields?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The Message-ID without angle brackets, as the send result stores it. */
export function bareMessageId(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const bare = id.trim().replace(/^<|>$/g, "");
  return bare === "" ? undefined : bare;
}

/**
 * The type of a `failed` event. A permanent failure is a hard bounce, and a temporary
 * one is a soft bounce, with these exceptions:
 * - `suppress-complaint`: the address complained before. It is a complaint.
 * - `suppress-unsubscribe`: the address unsubscribed before. It is not a bounce.
 * - `old`: Mailgun stopped the retries of a temporary failure. It is a soft bounce.
 */
function failed(data: Fields): { type: NormalizedEventType; bounce?: "hard" | "soft" } {
  const reason = text(data, "reason");
  if (text(data, "severity") !== "permanent" || reason === "old") {
    return { type: "bounced", bounce: "soft" };
  }
  if (reason === "suppress-complaint") return { type: "complained" };
  if (reason === "suppress-unsubscribe") return { type: "unknown" };
  return { type: "bounced", bounce: "hard" };
}

/**
 * Parses a verified Mailgun body into one event. The event key is the signature token.
 * Opens, clicks, and other types give an `unknown` event.
 */
export function parseMailgunEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const value = record(decodeJsonBytes(body));
  const token = record(value?.signature)?.token;
  const data = record(value?.["event-data"]);
  if (typeof token !== "string" || token === "" || !data) return [];
  const rawType = text(data, "event") ?? "unknown";
  let mapped: { type: NormalizedEventType; bounce?: "hard" | "soft" } = { type: "unknown" };
  if (rawType === "delivered") mapped = { type: "delivered" };
  else if (rawType === "complained") mapped = { type: "complained" };
  else if (rawType === "failed") mapped = failed(data);
  const event: NormalizedEvent = { type: mapped.type, provider, eventKey: token, rawType };
  if (mapped.bounce !== undefined) event.bounce = mapped.bounce;
  if (mapped.type === "bounced") {
    // Mailgun puts the SMTP reply in `message`. Some failures have only `description`.
    const status = record(data["delivery-status"]);
    const detail = bounceDetail({
      text: cleanBounceText(status?.message) ?? status?.description,
      smtpCode: status?.code,
      enhancedCode: status?.["enhanced-code"],
    });
    if (detail !== undefined) event.bounceDetail = detail;
  }
  const recipient = text(data, "recipient");
  if (recipient !== undefined) event.recipient = recipient;
  const headers = record(record(data.message)?.headers);
  const messageId = bareMessageId(headers?.["message-id"]);
  if (messageId !== undefined) event.providerMessageId = messageId;
  const seconds = data.timestamp;
  if (typeof seconds === "number" && Number.isFinite(seconds)) {
    event.occurredAt = Math.round(seconds * 1000);
  }
  return [event];
}

/** The webhook methods of the Mailgun adapter. */
export function mailgunWebhooks(provider: string): ProviderWebhooks {
  return {
    verify: verifyMailgunWebhook,
    parse: (body) => parseMailgunEvents(provider, body),
    signedTimestamp: true,
  };
}
