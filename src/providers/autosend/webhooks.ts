// AutoSend webhooks. AutoSend signs the raw body with HMAC-SHA256 and the webhook secret,
// and sends the hex digest in the `X-Webhook-Signature` header. Checked 2026-10-27.
// https://docs.autosend.com/others/webhooks/event-type.md
//
// The signature covers no timestamp. The `X-Webhook-Timestamp`, `X-Webhook-Event`, and
// `X-Webhook-Delivery-Id` headers are not signed, so mailswitch reads none of them. The
// event type and the event key come from the signed body only. The body has no event id,
// so the key is built from the type, `data.emailId`, the recipient, and `createdAt`. A
// replay of a signed body passes the signature check, so the webhook router must dedupe
// on that key.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { bytesToHex, utf8 } from "../../internal/encoding";
import { hmacSign, hmacVerify } from "../../internal/hmac";
import { asRecord, stringField } from "../../internal/json";
import { sha256Hex } from "../../internal/sha256";
import { decodeJsonBytes, hexToBytes } from "../../internal/webhook-bytes";

/** The header that carries the AutoSend signature. */
export const AUTOSEND_SIGNATURE_HEADER = "x-webhook-signature";

const SIGNATURE = /^[0-9a-f]{64}$/i;

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.spam_reported": "complained",
};

/** The HMAC key of a secret: the trimmed secret as UTF-8. */
function key(secret: string): string {
  return secret.trim();
}

/** The `X-Webhook-Signature` value of a raw body: the hex HMAC-SHA256 with the secret. */
export async function autosendSignature(secret: string, body: Uint8Array): Promise<string> {
  return bytesToHex(await hmacSign(key(secret), body));
}

/**
 * The `webhooks.verify` method of the AutoSend adapter.
 *
 * - An empty secret, a missing header, and a signature that does not match are
 *   `bad_signature`.
 * - A header that is not 64 hex characters is `malformed`.
 * - A verified body that is not one JSON object is `malformed`.
 */
export async function verifyAutosendWebhook(
  input: WebhookVerifyInput,
): Promise<WebhookVerifyResult> {
  if (key(input.secret) === "") return { ok: false, reason: "bad_signature" };
  const header = input.headers.get(AUTOSEND_SIGNATURE_HEADER);
  if (header === null) return { ok: false, reason: "bad_signature" };
  const hex = header.trim();
  if (!SIGNATURE.test(hex)) return { ok: false, reason: "malformed" };
  const signature = hexToBytes(hex) ?? new Uint8Array(0);
  if (!(await hmacVerify(key(input.secret), signature, input.body))) {
    return { ok: false, reason: "bad_signature" };
  }
  // The signature covers the raw bytes. Only a verified body is decoded.
  return asRecord(decodeJsonBytes(input.body)) === undefined
    ? { ok: false, reason: "malformed" }
    : { ok: true };
}

/** The recipient address of `data.to`, as an object or as text. */
function recipientOf(data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined;
  const to = data.to;
  if (typeof to === "string") return stringField(data, "to");
  const record = asRecord(to);
  return record === undefined ? undefined : stringField(record, "email");
}

/**
 * Parses a verified AutoSend body. One request holds one event.
 *
 * - The event type is the body `type`, or `event` when `type` is missing. A body with
 *   neither gives `unknown`. The `X-Webhook-Event` header is never read.
 * - `email.delivered` maps to `delivered`, `email.spam_reported` to `complained`, and
 *   `email.bounced` to `bounced`. `bounceType: Permanent` is hard and `Transient` is soft.
 *   Any other bounce type has no class. Every other event gives `unknown`.
 * - The event key is the SHA-256 of the type, `data.emailId`, the lowercase recipient,
 *   and `createdAt`. When `data.emailId` or `createdAt` is missing, the key is the SHA-256
 *   of the raw body. The `X-Webhook-Delivery-Id` header is never read.
 * - `providerMessageId` is `data.emailId`, the id in the send result. `recipient` is
 *   `data.to.email`. `occurredAt` is `createdAt` in Unix milliseconds.
 */
export function parseAutosendEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const root = asRecord(decodeJsonBytes(body));
  if (root === undefined) return [];
  const rawType = stringField(root, "type") ?? stringField(root, "event") ?? "unknown";
  const type = TYPES[rawType] ?? "unknown";
  const data = asRecord(root.data);
  const messageId = data === undefined ? undefined : stringField(data, "emailId");
  const recipient = recipientOf(data);
  const createdAt = stringField(root, "createdAt");
  const eventKey =
    messageId === undefined || createdAt === undefined
      ? sha256Hex(body)
      : sha256Hex(
          utf8(JSON.stringify([rawType, messageId, recipient?.toLowerCase() ?? "", createdAt])),
        );
  const event: NormalizedEvent = { type, provider, eventKey, rawType };
  if (type === "bounced" && data !== undefined) {
    const bounceType = stringField(data, "bounceType");
    if (bounceType === "Permanent") event.bounce = "hard";
    else if (bounceType === "Transient") event.bounce = "soft";
  }
  if (recipient !== undefined) event.recipient = recipient;
  if (messageId !== undefined) event.providerMessageId = messageId;
  const at = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  if (Number.isFinite(at)) event.occurredAt = at;
  return [event];
}

/** The webhook methods of the AutoSend adapter. */
export function autosendWebhooks(provider: string): ProviderWebhooks {
  return {
    verify: verifyAutosendWebhook,
    parse: (body) => parseAutosendEvents(provider, body),
    signedTimestamp: false,
  };
}
