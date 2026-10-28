// Brevo transactional webhooks. https://developers.brevo.com/docs/transactional-webhooks
// The code lives here and not under one provider, because two subpaths re-export it:
// `mailswitch/smtp/brevo` for the Brevo preset of the SMTP adapter, and the Brevo API
// adapter. An adapter must not import another provider.
//
// Brevo signs nothing. When you create the webhook with `auth: { type: "bearer", token }`,
// Brevo sends the token in the Authorization header. The token is the webhook secret.
// - The check compares SHA-256 digests of the tokens in constant time.
// - The token covers no timestamp and no body. A replayed request passes the check, so
//   the webhook router must dedupe on the event key. Use HTTPS for the webhook URL.
//
// Event mapping:
//   delivered                   -> delivered
//   hard_bounce, invalid_email  -> bounced (hard)
//   soft_bounce                 -> bounced (soft)
//   spam                        -> complained
//   any other event             -> unknown, with the Brevo name in rawType
//
// Brevo sends no event id. The event key joins the event name, the message-id, the
// recipient, and the event time, as Envelopen does. A retry of one delivery gives the
// same key.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../core/adapter";
import type { NormalizedEvent } from "../core/events";
import { bounceDetail } from "./bounce-detail";
import { numberField, stringField } from "./json";
import {
  checkSharedTokenSecret,
  generateSharedTokenSecret,
  isStrongSharedTokenSecret,
} from "./shared-token";
import { decodeJsonBytes, timingSafeEqualText } from "./webhook-bytes";

/** The shortest token, in characters, when it is not hex only. 22 base64url characters hold 128 bits. */
export const BREVO_MIN_TOKEN_LENGTH = 22;
/** The shortest token that holds only hex characters. */
export const BREVO_MIN_HEX_TOKEN_LENGTH = 32;
/** The Brevo events that mailswitch maps. Give them when you create the webhook. */
export const BREVO_WEBHOOK_EVENTS: readonly string[] = [
  "delivered",
  "hardBounce",
  "softBounce",
  "invalid",
  "spam",
  "unsubscribed",
];
/** The most events that one request can hold. Brevo batches events only when you ask. */
const MAX_EVENTS = 100;
const BEARER = /^([A-Za-z]+)[ \t]+(\S+)[ \t]*$/;

/**
 * Checks that a webhook token holds at least 128 bits, as far as its length shows.
 *
 * @throws TypeError for a token that is too short. The message never holds the token.
 */
export function checkBrevoWebhookToken(token: string): void {
  checkSharedTokenSecret(token, "Brevo");
}

/** Makes a webhook token of 32 random bytes, as 43 base64url characters. */
export const generateBrevoWebhookToken: () => string = generateSharedTokenSecret;

/** Checks the bearer token and the body shape. It never throws for a bad request. */
export async function verifyBrevoWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  // A weak token is a setup error on this side. It is not the sender's fault.
  if (!isStrongSharedTokenSecret(input.secret)) return { ok: false, reason: "invalid_secret" };
  const header = input.headers.get("authorization");
  if (header === null) return { ok: false, reason: "bad_signature" };
  const match = BEARER.exec(header.trim());
  if (!match) return { ok: false, reason: "malformed" };
  if ((match[1] as string).toLowerCase() !== "bearer") {
    return { ok: false, reason: "bad_signature" };
  }
  if (!(await timingSafeEqualText(match[2] as string, input.secret)))
    return { ok: false, reason: "bad_signature" };
  const value = decodeJsonBytes(input.body);
  if (typeof value !== "object" || value === null) return { ok: false, reason: "malformed" };
  return { ok: true };
}

type Fields = Record<string, unknown>;

/** The event time in Unix milliseconds: `ts_epoch`, else `ts_event` or `ts` in seconds. */
function occurredAt(record: Fields): number | undefined {
  const epoch = numberField(record, "ts_epoch");
  if (epoch !== undefined) return epoch;
  const seconds = numberField(record, "ts_event") ?? numberField(record, "ts");
  return seconds === undefined ? undefined : seconds * 1000;
}

function eventOf(provider: string, record: Fields): NormalizedEvent | null {
  const rawType = stringField(record, "event");
  if (rawType === undefined) return null;
  const recipient = stringField(record, "email");
  const messageId = stringField(record, "message-id");
  const at = occurredAt(record);
  const eventKey = [rawType, messageId ?? "", recipient?.toLowerCase() ?? "", at ?? ""].join(":");
  const event: NormalizedEvent = { type: "unknown", provider, eventKey, rawType };
  if (rawType === "delivered") event.type = "delivered";
  else if (rawType === "spam") event.type = "complained";
  else if (rawType === "unsubscribed") event.type = "unsubscribed";
  else if (rawType === "hard_bounce" || rawType === "invalid_email") {
    event.type = "bounced";
    event.bounce = "hard";
  } else if (rawType === "soft_bounce") {
    event.type = "bounced";
    event.bounce = "soft";
  }
  if (event.type === "bounced") {
    const detail = bounceDetail({ text: record.reason });
    if (detail !== undefined) event.bounceDetail = detail;
  }
  if (recipient !== undefined) event.recipient = recipient;
  if (messageId !== undefined) event.providerMessageId = messageId;
  if (at !== undefined) event.occurredAt = at;
  return event;
}

/**
 * Parses a verified Brevo body: one event object, or a list when batching is on. An
 * entry with no event name is skipped. A repeated event key is kept once.
 */
export function parseBrevoEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const value = decodeJsonBytes(body);
  const list = Array.isArray(value) ? value.slice(0, MAX_EVENTS) : [value];
  const events: NormalizedEvent[] = [];
  const keys = new Set<string>();
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const event = eventOf(provider, item as Fields);
    if (event === null || keys.has(event.eventKey)) continue;
    keys.add(event.eventKey);
    events.push(event);
  }
  return events;
}

/**
 * The webhook methods for the Brevo preset. Pass them to `smtp({ webhooks })`. The
 * events carry `provider`, which defaults to the SMTP adapter id.
 */
export function brevoWebhooks(provider: string = "smtp"): ProviderWebhooks {
  return {
    verify: verifyBrevoWebhook,
    parse: (body) => parseBrevoEvents(provider, body),
    signedTimestamp: false,
  };
}
