// SendGrid Event Webhook. SendGrid signs each request with ECDSA P-256 and SHA-256.
// https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
// https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event
//
// The signed data is the `X-Twilio-Email-Event-Webhook-Timestamp` value followed by the
// raw body bytes. The `X-Twilio-Email-Event-Webhook-Signature` header holds the DER
// signature in base64. The webhook secret is the public verification key from the
// SendGrid console, a base64 SubjectPublicKeyInfo. SendGrid retries a failed request, and
// each retry carries a new signature, so the webhook router must dedupe on `sg_event_id`.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { ecdsaP256Verify } from "../../internal/ecdsa";
import { base64ToBytes, utf8 } from "../../internal/encoding";
import { decodeJsonBytes } from "../../internal/webhook-bytes";

/** The signature header of a SendGrid Event Webhook request. */
export const SENDGRID_SIGNATURE_HEADER = "x-twilio-email-event-webhook-signature";
/** The timestamp header of a SendGrid Event Webhook request. */
export const SENDGRID_TIMESTAMP_HEADER = "x-twilio-email-event-webhook-timestamp";
/** The timestamp window, in both directions, in milliseconds. */
export const SENDGRID_WEBHOOK_TOLERANCE_MS: number = 5 * 60 * 1000;

/** The bytes that SendGrid signs: the timestamp text followed by the raw body. */
export function sendgridSignedPayload(timestamp: string, body: Uint8Array): Uint8Array {
  const prefix = utf8(timestamp);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

/**
 * Reads the public key text. It accepts the base64 key as the console shows it, and also
 * a PEM block, with the armor lines and the white space removed.
 *
 * @throws TypeError when the key is not base64. The message never holds the key.
 */
function keyText(secret: string): string {
  const text = secret.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  if (base64ToBytes(text) === null) {
    throw new TypeError("The SendGrid webhook secret is not a base64 public key.");
  }
  return text;
}

/**
 * The `webhooks.verify` method of the SendGrid adapter. An empty secret is refused as
 * `bad_signature`.
 *
 * @throws TypeError when the secret is set but is not base64. That is a setup error, not
 * a bad request.
 */
export async function verifySendgridWebhook(
  input: WebhookVerifyInput,
): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const key = keyText(input.secret);
  const signature = input.headers.get(SENDGRID_SIGNATURE_HEADER);
  const timestamp = input.headers.get(SENDGRID_TIMESTAMP_HEADER);
  if (!signature || !timestamp) return { ok: false, reason: "bad_signature" };
  const der = base64ToBytes(signature.trim());
  if (!/^\d{1,12}$/.test(timestamp) || der === null) return { ok: false, reason: "malformed" };
  if (!(await ecdsaP256Verify(key, der, sendgridSignedPayload(timestamp, input.body)))) {
    return { ok: false, reason: "bad_signature" };
  }
  // A replayed request carries its old timestamp, and the signature covers it.
  if (Math.abs(input.now - Number(timestamp) * 1000) > SENDGRID_WEBHOOK_TOLERANCE_MS) {
    return { ok: false, reason: "stale" };
  }
  // The signature covers the raw bytes. Only a verified body is decoded.
  return Array.isArray(decodeJsonBytes(input.body))
    ? { ok: true }
    : { ok: false, reason: "malformed" };
}

type Fields = Record<string, unknown>;

function text(record: Fields, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  delivered: "delivered",
  spamreport: "complained",
};

/**
 * Parses a verified SendGrid body. One body is a JSON array of events.
 *
 * - `bounce` with `type: "bounce"` is a hard bounce. `bounce` with `type: "blocked"` is a
 *   soft bounce. A bounce with any other type is `unknown`.
 * - `delivered` maps to `delivered`. `spamreport` maps to `complained`. Every other event,
 *   such as `open` or `dropped`, gives `unknown`.
 * - `rawType` is the `event` value. The event key is `sg_event_id`, which SendGrid gives
 *   for dedupe. An event without it gets `sg_message_id:event:timestamp:email:index`.
 * - `providerMessageId` is `sg_message_id` as SendGrid sends it.
 */
export function parseSendgridEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const value = decodeJsonBytes(body);
  if (!Array.isArray(value)) return [];
  const out: NormalizedEvent[] = [];
  value.forEach((item: unknown, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return;
    const record = item as Fields;
    const rawType = text(record, "event") ?? "unknown";
    const bounceType = text(record, "type");
    const bounce =
      rawType !== "bounce"
        ? undefined
        : bounceType === "bounce"
          ? "hard"
          : bounceType === "blocked"
            ? "soft"
            : undefined;
    const type: NormalizedEventType = bounce ? "bounced" : (TYPES[rawType] ?? "unknown");
    const recipient = text(record, "email");
    const messageId = text(record, "sg_message_id");
    const seconds = record.timestamp;
    const eventKey =
      text(record, "sg_event_id") ??
      [messageId, rawType, String(seconds ?? ""), recipient?.toLowerCase(), index].join(":");
    const event: NormalizedEvent = { type, provider, eventKey, rawType };
    if (bounce !== undefined) event.bounce = bounce;
    if (recipient !== undefined) event.recipient = recipient;
    if (messageId !== undefined) event.providerMessageId = messageId;
    if (typeof seconds === "number" && Number.isFinite(seconds)) event.occurredAt = seconds * 1000;
    out.push(event);
  });
  return out;
}

/** The webhook methods of the SendGrid adapter. */
export function sendgridWebhooks(provider: string): ProviderWebhooks {
  return {
    verify: verifySendgridWebhook,
    parse: (body) => parseSendgridEvents(provider, body),
    signedTimestamp: true,
  };
}
