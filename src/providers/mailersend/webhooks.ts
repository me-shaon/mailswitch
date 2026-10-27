// MailerSend webhooks. MailerSend signs the raw body with HMAC-SHA256 and the signing
// secret of the webhook, and sends the hex digest in the `Signature` header. The signature
// covers no timestamp, and MailerSend retries a failed request for up to about 3 days. A
// replayed body passes the signature check, so the webhook router must dedupe on the
// event key: the activity id `data.id`.
// https://developers.mailersend.com/api/v1/account/webhooks
// https://developers.mailersend.com/guides/setting-up-webhooks

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { bytesToHex } from "../../internal/encoding";
import { hmacSign, hmacVerify } from "../../internal/hmac";
import { sha256Hex } from "../../internal/sha256";
import { decodeJsonBytes, hexToBytes } from "../../internal/webhook-bytes";

/** The header that carries the MailerSend signature. */
export const MAILERSEND_SIGNATURE_HEADER = "signature";

const SIGNATURE = /^[0-9a-f]{64}$/i;

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  "activity.delivered": "delivered",
  "activity.hard_bounced": "bounced",
  "activity.soft_bounced": "bounced",
  "activity.spam_complaint": "complained",
  // The example payload of the spam complaint event uses the plural form.
  "activity.spam_complaints": "complained",
};

/** The `Signature` value of a raw body: the hex HMAC-SHA256 with the signing secret. */
export async function mailersendSignature(secret: string, body: Uint8Array): Promise<string> {
  return bytesToHex(await hmacSign(secret, body));
}

/**
 * The `webhooks.verify` method of the MailerSend adapter. An empty secret is refused as
 * `bad_signature`.
 */
export async function verifyMailersendWebhook(
  input: WebhookVerifyInput,
): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const header = input.headers.get(MAILERSEND_SIGNATURE_HEADER);
  if (header === null) return { ok: false, reason: "bad_signature" };
  const hex = header.trim();
  if (!SIGNATURE.test(hex)) return { ok: false, reason: "malformed" };
  const valid = await hmacVerify(input.secret, hexToBytes(hex) ?? new Uint8Array(0), input.body);
  if (!valid) return { ok: false, reason: "bad_signature" };
  // The signature covers the raw bytes. Only a verified body is decoded.
  const value = decodeJsonBytes(input.body);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true };
}

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

function text(fields: Fields | undefined, name: string): string | undefined {
  const value = fields?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parses a verified MailerSend body. One body holds one event.
 *
 * - `activity.delivered` maps to `delivered`, `activity.hard_bounced` and
 *   `activity.soft_bounced` to `bounced` hard and soft, and `activity.spam_complaint` to
 *   `complained`. Every other type gives `unknown`.
 * - `rawType` is the top-level `type`. The event key is `data.id`. A body without it gets
 *   the SHA-256 of the raw body.
 * - `providerMessageId` is `data.message_id`, or `data.email.message.id` in the older
 *   payload shape. It is the `x-message-id` value of the send.
 */
export function parseMailersendEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const value = record(decodeJsonBytes(body));
  if (value === undefined) return [];
  const data = record(value.data);
  const email = record(data?.email);
  const rawType = text(value, "type") ?? "unknown";
  const type = TYPES[rawType] ?? "unknown";
  const eventKey = text(data, "id") ?? sha256Hex(body);
  const event: NormalizedEvent = { type, provider, eventKey, rawType };
  if (type === "bounced") event.bounce = rawType === "activity.hard_bounced" ? "hard" : "soft";
  const recipient = text(data, "recipient") ?? text(record(email?.recipient), "email");
  if (recipient !== undefined) event.recipient = recipient;
  const messageId = text(data, "message_id") ?? text(record(email?.message), "id");
  if (messageId !== undefined) event.providerMessageId = messageId;
  const at = Date.parse(text(value, "created_at") ?? text(data, "created_at") ?? "");
  if (Number.isFinite(at)) event.occurredAt = at;
  return [event];
}

/** The webhook methods of the MailerSend adapter. */
export function mailersendWebhooks(provider: string): ProviderWebhooks {
  return {
    verify: verifyMailersendWebhook,
    parse: (body) => parseMailersendEvents(provider, body),
    signedTimestamp: false,
  };
}
