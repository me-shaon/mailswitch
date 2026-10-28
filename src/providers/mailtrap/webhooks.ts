// Mailtrap webhooks. Mailtrap signs the raw body with HMAC-SHA256 and the signing secret
// of the webhook, and sends the lowercase hex digest in the `Mailtrap-Signature` header.
// Checked 2026-10-27.
// https://docs.mailtrap.io/email-api-smtp/advanced/webhooks.md
//
// The signature covers no timestamp, and Mailtrap retries a failed request 40 times, every
// 5 minutes. A replayed body passes the signature check, so the webhook router must dedupe
// on the event key: the signed body `event_id` of each event. One request holds up to 500
// events in `{"events": [...]}`. Use the JSON format, not JSON Lines.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { bounceDetail } from "../../internal/bounce-detail";
import { bytesToHex } from "../../internal/encoding";
import { checkHexHmac } from "../../internal/hex-hmac-webhook";
import { hmacSign } from "../../internal/hmac";
import { asRecord, numberField, stringField } from "../../internal/json";
import { sha256Hex } from "../../internal/sha256";
import { decodeJsonBytes } from "../../internal/webhook-bytes";

/** The header that carries the Mailtrap signature. */
export const MAILTRAP_SIGNATURE_HEADER = "mailtrap-signature";

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  delivery: "delivered",
  bounce: "bounced",
  "soft bounce": "bounced",
  spam: "complained",
  unsubscribe: "unsubscribed",
};

/** The `Mailtrap-Signature` value of a raw body: the hex HMAC-SHA256 with the secret. */
export async function mailtrapSignature(secret: string, body: Uint8Array): Promise<string> {
  return bytesToHex(await hmacSign(secret, body));
}

/** The `events` list of a decoded body, or undefined when the body has none. */
function eventList(body: Uint8Array): unknown[] | undefined {
  const events = asRecord(decodeJsonBytes(body))?.events;
  return Array.isArray(events) ? events : undefined;
}

/**
 * The `webhooks.verify` method of the Mailtrap adapter.
 *
 * - An empty secret, a missing header, and a signature that does not match are
 *   `bad_signature`.
 * - A header that is not 64 hex characters is `malformed`.
 * - A verified body that is not one JSON object with an `events` list is `malformed`.
 */
export async function verifyMailtrapWebhook(
  input: WebhookVerifyInput,
): Promise<WebhookVerifyResult> {
  const reason = await checkHexHmac(
    input.secret,
    input.headers,
    MAILTRAP_SIGNATURE_HEADER,
    input.body,
  );
  if (reason !== undefined) return { ok: false, reason };
  return eventList(input.body) === undefined ? { ok: false, reason: "malformed" } : { ok: true };
}

/**
 * Parses a verified Mailtrap body. Each entry of `events` gives one event. An entry that
 * is not an object is skipped.
 *
 * - `delivery` maps to `delivered`, `bounce` to `bounced` hard, `soft bounce` to `bounced`
 *   soft, `spam` to `complained`, and `unsubscribe` to `unsubscribed`. Every other event,
 *   for example `reject`, `suspension`, `open`, and `click`, gives `unknown`.
 * - `rawType` is the `event` value. The event key is `event_id`. An entry without it gets
 *   the SHA-256 of the raw body and the entry index.
 * - `providerMessageId` is `message_id`, the id in the send result. `recipient` is `email`.
 *   `occurredAt` is the Unix `timestamp` in milliseconds.
 */
export function parseMailtrapEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const list = eventList(body) ?? [];
  const out: NormalizedEvent[] = [];
  let bodyHash: string | undefined;
  list.forEach((item, index) => {
    const entry = asRecord(item);
    if (entry === undefined) return;
    const rawType = stringField(entry, "event") ?? "unknown";
    const type = TYPES[rawType] ?? "unknown";
    let eventKey = stringField(entry, "event_id");
    if (eventKey === undefined) {
      bodyHash ??= sha256Hex(body);
      eventKey = `${bodyHash}:${index}`;
    }
    const event: NormalizedEvent = { type, provider, eventKey, rawType };
    if (type === "bounced") {
      event.bounce = rawType === "bounce" ? "hard" : "soft";
      const detail = bounceDetail({ text: entry.response, smtpCode: entry.response_code });
      if (detail !== undefined) event.bounceDetail = detail;
    }
    const recipient = stringField(entry, "email");
    if (recipient !== undefined) event.recipient = recipient;
    const messageId = stringField(entry, "message_id");
    if (messageId !== undefined) event.providerMessageId = messageId;
    const at = numberField(entry, "timestamp");
    if (at !== undefined) event.occurredAt = at * 1000;
    out.push(event);
  });
  return out;
}

/** The webhook methods of the Mailtrap adapter. */
export function mailtrapWebhooks(provider: string): ProviderWebhooks {
  return {
    verify: verifyMailtrapWebhook,
    parse: (body) => parseMailtrapEvents(provider, body),
    signedTimestamp: false,
  };
}
