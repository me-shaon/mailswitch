// toSend webhooks. toSend signs the raw body with HMAC-SHA256 and sends the hex digest in
// `X-ToSend-Signature: sha256=<hex>`. The signature covers no timestamp, and toSend sends
// each event once with no retry. A replayed body passes the signature check, so the
// webhook router must dedupe on the event key: the SHA-256 of the raw body.
// https://tosend.com/docs/guide/webhooks/

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { bytesToHex } from "../../internal/encoding";
import { hmacSign, hmacVerify } from "../../internal/hmac";
import { sha256Hex } from "../../internal/sha256";
import { decodeJsonBytes, hexToBytes } from "../../internal/webhook-bytes";

/** The header that carries the toSend signature. */
export const TOSEND_SIGNATURE_HEADER = "x-tosend-signature";

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  bounced: "bounced",
  complaint: "complained",
  delivered: "delivered",
};

/** The `X-ToSend-Signature` value of a raw body: `sha256=` and the hex HMAC-SHA256. */
export async function toSendSignature(secret: string, body: Uint8Array): Promise<string> {
  return `sha256=${bytesToHex(await hmacSign(secret, body))}`;
}

async function verify(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const header = input.headers.get(TOSEND_SIGNATURE_HEADER);
  if (header === null) return { ok: false, reason: "bad_signature" };
  const match = SIGNATURE.exec(header.trim());
  if (!match) return { ok: false, reason: "malformed" };
  const valid = await hmacVerify(
    input.secret,
    hexToBytes(match[1] as string) ?? new Uint8Array(0),
    input.body,
  );
  if (!valid) return { ok: false, reason: "bad_signature" };
  const value = decodeJsonBytes(input.body);
  if (typeof value !== "object" || value === null) return { ok: false, reason: "malformed" };
  return { ok: true };
}

type Fields = Record<string, unknown>;

function field(record: Fields | undefined, name: string): string | undefined {
  const value = record?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function toEvent(provider: string, item: unknown, eventKey: string): NormalizedEvent {
  const record = typeof item === "object" && item !== null ? (item as Fields) : {};
  const data =
    typeof record.data === "object" && record.data !== null ? (record.data as Fields) : undefined;
  const rawType = field(record, "type") ?? "unknown";
  const type = TYPES[rawType] ?? "unknown";
  const event: NormalizedEvent = { type, provider, eventKey, rawType };
  if (type === "bounced") {
    const hard = data?.is_hard_bounce;
    event.bounce =
      typeof hard === "boolean"
        ? hard
          ? "hard"
          : "soft"
        : field(data, "bounce_type") === "Permanent"
          ? "hard"
          : "soft";
  }
  const recipient = field(data, "email");
  if (recipient !== undefined) event.recipient = recipient;
  const messageId = field(data, "message_id");
  if (messageId !== undefined) event.providerMessageId = messageId;
  const at = Date.parse(
    field(data, "timestamp") ?? field(record, "created_at") ?? field(data, "created_at") ?? "",
  );
  if (Number.isFinite(at)) event.occurredAt = at;
  return event;
}

/**
 * Parses a verified toSend body. toSend documents one event per request. A body that
 * holds an array of events gives one event per item, and each key gets the item index,
 * so two recipients of one message give two keys.
 */
function parse(provider: string, body: Uint8Array): NormalizedEvent[] {
  const value = decodeJsonBytes(body);
  if (typeof value !== "object" || value === null) return [];
  const key = sha256Hex(body);
  if (!Array.isArray(value)) return [toEvent(provider, value, key)];
  return value.map((item, index) => toEvent(provider, item, `${key}.${index}`));
}

/** The webhook methods of the toSend adapter. */
export function toSendWebhooks(provider: string): ProviderWebhooks {
  return { verify, parse: (body) => parse(provider, body), signedTimestamp: false };
}
