// AhaSend webhooks. AhaSend signs each request with Standard Webhooks headers. Checked
// 2026-10-27.
// https://ahasend.com/docs/api-reference/webhooks/security.md
// https://ahasend.com/docs/integrations/webhooks.md
//
// A request carries three headers:
//
//   webhook-id: <delivery id>
//   webhook-timestamp: <unix seconds>
//   webhook-signature: v1,<base64> [v1,<base64> ...]
//
// The signed content is `${id}.${timestamp}.${raw body}`, with HMAC-SHA256. The key is the
// literal UTF-8 bytes of the secret, with its `aha-whsec-` prefix. It is not base64
// decoded. A delivery passes when any `v1` entry matches. The signature covers the
// timestamp, so an old request is refused as stale. The event key is the signed
// `webhook-id`. A retry can get a new signature, so the webhook router must dedupe.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { base64ToBytes, utf8 } from "../../internal/encoding";
import { hmacVerify } from "../../internal/hmac";
import { asRecord, stringField } from "../../internal/json";
import { decodeJsonBytes } from "../../internal/webhook-bytes";

/** The header that holds the delivery id. */
export const AHASEND_ID_HEADER = "webhook-id";
/** The header that holds the signed Unix time in seconds. */
export const AHASEND_TIMESTAMP_HEADER = "webhook-timestamp";
/** The header that holds the signatures. */
export const AHASEND_SIGNATURE_HEADER = "webhook-signature";
/** The timestamp window, in both directions, in milliseconds. AhaSend recommends 5 minutes. */
export const AHASEND_WEBHOOK_TOLERANCE_MS: number = 5 * 60 * 1000;

/** The most signature entries that the check reads from one header. */
const MAX_SIGNATURES = 10;
const SIGNATURE_BYTES = 32;
const TIMESTAMP = /^\d{1,12}$/;
// A delivery id is short header text. The limit keeps a huge header out of the HMAC input.
const DELIVERY_ID = /^[\x21-\x7e]{1,256}$/;

/** The bytes that AhaSend signs: `${id}.${timestamp}.` followed by the raw body. */
export function ahasendSignedPayload(id: string, timestamp: string, body: Uint8Array): Uint8Array {
  const prefix = utf8(`${id}.${timestamp}.`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

/**
 * The `webhooks.verify` method of the AhaSend adapter.
 *
 * - An empty secret, a missing header, and a signature that does not match are
 *   `bad_signature`.
 * - A timestamp or a delivery id that cannot be read is `malformed`.
 * - A signed timestamp more than 5 minutes in the past or in the future is `stale`.
 * - A verified body that is not one JSON object is `malformed`.
 */
export async function verifyAhasendWebhook(
  input: WebhookVerifyInput,
): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const id = input.headers.get(AHASEND_ID_HEADER);
  const timestamp = input.headers.get(AHASEND_TIMESTAMP_HEADER);
  const signature = input.headers.get(AHASEND_SIGNATURE_HEADER);
  if (!id || !timestamp || !signature) return { ok: false, reason: "bad_signature" };
  if (!TIMESTAMP.test(timestamp) || !DELIVERY_ID.test(id)) {
    return { ok: false, reason: "malformed" };
  }
  const signed = ahasendSignedPayload(id, timestamp, input.body);
  const entries = signature.split(" ").filter((entry) => entry !== "");
  let valid = false;
  for (const entry of entries.slice(0, MAX_SIGNATURES)) {
    const cut = entry.indexOf(",");
    if (cut < 0 || entry.slice(0, cut) !== "v1") continue;
    const bytes = base64ToBytes(entry.slice(cut + 1));
    if (!bytes || bytes.length !== SIGNATURE_BYTES) continue;
    // The raw secret text is the key, with its prefix. hmacVerify compares in constant time.
    if (await hmacVerify(input.secret, bytes, signed)) {
      valid = true;
      break;
    }
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  // A replayed request carries its old timestamp, and the signature covers it.
  if (Math.abs(input.now - Number(timestamp) * 1000) > AHASEND_WEBHOOK_TOLERANCE_MS) {
    return { ok: false, reason: "stale" };
  }
  // Only a verified body is decoded.
  return asRecord(decodeJsonBytes(input.body)) === undefined
    ? { ok: false, reason: "malformed" }
    : { ok: true };
}

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  "message.delivered": "delivered",
  "message.bounced": "bounced",
  "message.transient_error": "bounced",
  "message.complained": "complained",
};

/**
 * Parses one AhaSend webhook body. One request holds one event.
 *
 * - The event key is the signed `webhook-id` header.
 * - `message.bounced` is a bounce with no class. `message.transient_error` is a soft
 *   bounce. Any other unmapped type is `unknown` with its raw type.
 * - `providerMessageId` is `data.id`, the id of the send result. `recipient` is
 *   `data.recipient`. `occurredAt` comes from the body `timestamp`.
 */
export function parseAhasendEvents(
  provider: string,
  body: Uint8Array,
  headers: Headers,
): NormalizedEvent[] {
  const record = asRecord(decodeJsonBytes(body));
  if (record === undefined) return [];
  const rawType = stringField(record, "type") ?? "unknown";
  const data = asRecord(record.data) ?? {};
  const messageId = stringField(data, "id");
  const stamp = stringField(record, "timestamp") ?? "";
  const eventKey =
    headers.get(AHASEND_ID_HEADER) ||
    [stringField(record, "webhook_id") ?? "", messageId ?? "", rawType, stamp].join(":");
  const type = TYPES[rawType] ?? "unknown";
  const event: NormalizedEvent = { type, provider, eventKey, rawType };
  if (rawType === "message.transient_error") event.bounce = "soft";
  const recipient = stringField(data, "recipient");
  if (recipient !== undefined) event.recipient = recipient;
  if (messageId !== undefined) event.providerMessageId = messageId;
  const at = Date.parse(stamp);
  if (Number.isFinite(at)) event.occurredAt = at;
  return [event];
}

/** The webhook methods of the AhaSend adapter. */
export function ahasendWebhooks(provider: string): ProviderWebhooks {
  return {
    verify: verifyAhasendWebhook,
    parse: (body, headers) => parseAhasendEvents(provider, body, headers),
    signedTimestamp: true,
  };
}
