// SMTP2GO webhooks. SMTP2GO signs nothing. A webhook can send an Authorization header:
// `auth_header_type` is `bearer` or `basic`, and `auth_header_value` is the token, or the
// base64 of `user:pass`. Credentials in the webhook URL also give a Basic header. The
// token, or the Basic password, is the webhook secret.
// https://developers.smtp2go.com/reference/add-webhook.md
// https://developers.smtp2go.com/docs/webhooks-overview.md
//
// The token covers no timestamp and no body. SMTP2GO retries a failed request for up to
// 48 h. A replayed request passes the check, so the webhook router must dedupe on the
// event key. A changed body also passes the check. Use HTTPS for the webhook URL.
//
// The default `output_format` is `form`. mailswitch reads only `json`, so a form body is
// `malformed`.
//
// Event mapping:
//   delivered                 -> delivered
//   bounce, bounce: hard      -> bounced (hard)
//   bounce, bounce: soft      -> bounced (soft)
//   bounce, no hard or soft   -> bounced, with no bounce class
//   spam                      -> complained
//   any other event           -> unknown, with the SMTP2GO name in rawType
//
// The event key is the `id` field ("The unique id for the webhook").

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent } from "../../core/events";
import { bounceDetail } from "../../internal/bounce-detail";
import { bytesToBase64, utf8 } from "../../internal/encoding";
import { asRecord } from "../../internal/json";
import {
  checkSharedTokenSecret,
  generateSharedTokenSecret,
  sharedTokenVerifier,
} from "../../internal/shared-token";
import { decodeJsonBytes } from "../../internal/webhook-bytes";

/** The default Basic auth username of an SMTP2GO webhook. */
export const SMTP2GO_WEBHOOK_USERNAME = "mailswitch";

/** The options of the SMTP2GO webhook verifier. */
export interface Smtp2goWebhookOptions {
  /** The Basic auth username. Defaults to `SMTP2GO_WEBHOOK_USERNAME`. Bearer uses none. */
  username?: string;
  /**
   * The secret before a rotation. While it is set, a request with this secret also
   * passes. Remove it when SMTP2GO sends the new secret.
   */
  previousSecret?: string;
}

/** The auth fields of an SMTP2GO webhook, as `POST /v3/webhook/add` takes them. */
export interface Smtp2goWebhookAuth {
  auth_header_type: "bearer" | "basic";
  auth_header_value: string;
}

/**
 * Checks that a webhook secret holds at least 128 bits, as far as its length shows.
 *
 * @throws TypeError for a secret that is too short. The message never holds the secret.
 */
export function checkSmtp2goWebhookSecret(secret: string): void {
  checkSharedTokenSecret(secret, "SMTP2GO");
}

/** Makes a webhook secret of 32 random bytes, as 43 base64url characters (256 bits). */
export const generateSmtp2goWebhookSecret: () => string = generateSharedTokenSecret;

/**
 * The `auth_header_type` and `auth_header_value` to give SMTP2GO for a secret. Bearer
 * sends the secret as the token. Basic sends the base64 of `username:secret`.
 *
 * @throws TypeError for a weak secret.
 */
export function smtp2goWebhookAuth(
  secret: string,
  type: "bearer" | "basic" = "bearer",
  username: string = SMTP2GO_WEBHOOK_USERNAME,
): Smtp2goWebhookAuth {
  checkSmtp2goWebhookSecret(secret);
  return {
    auth_header_type: type,
    auth_header_value: type === "bearer" ? secret : bytesToBase64(utf8(`${username}:${secret}`)),
  };
}

type Fields = Record<string, unknown>;

/**
 * Makes the `verify` method. It checks the Bearer or Basic header with the shared token
 * helper, then checks that the body is one JSON event object or a list of them.
 *
 * @throws TypeError for an invalid username or a weak `previousSecret`.
 */
function verifier(
  options: Smtp2goWebhookOptions,
): (input: WebhookVerifyInput) => Promise<WebhookVerifyResult> {
  const check = sharedTokenVerifier({
    name: "SMTP2GO",
    schemes: [
      { type: "bearer" },
      { type: "basic", username: options.username ?? SMTP2GO_WEBHOOK_USERNAME },
    ],
    ...(options.previousSecret === undefined ? {} : { previousSecret: options.previousSecret }),
  });
  return async (input) => {
    const auth = await check(input.headers, input.secret);
    if (!auth.ok) return auth;
    const value = decodeJsonBytes(input.body);
    const ok = Array.isArray(value)
      ? value.length > 0 && value.every((item) => asRecord(item) !== undefined)
      : asRecord(value) !== undefined;
    return ok ? { ok: true } : { ok: false, reason: "malformed" };
  };
}

function text(record: Fields, name: string): string | undefined {
  const value = record[name];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The event time in Unix milliseconds: Unix seconds, Unix milliseconds, or a date text. */
function millis(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isFinite(number) && number > 0) {
    return Math.round(number < 1e12 ? number * 1000 : number);
  }
  if (typeof value !== "string") return undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date;
}

/**
 * Parses a verified SMTP2GO JSON body: one event object, or a list. An entry with no
 * `event` is skipped. A repeated event key is kept once.
 *
 * - `delivered` maps to `delivered`, `bounce` to `bounced`, `spam` to `complained`, and
 *   `unsubscribe` to `unsubscribed`. Every other event, such as `resubscribe`, gives
 *   `unknown`.
 * - The event key joins `id`, `event`, `email_id`, `rcpt`, and `time`. The docs call `id`
 *   the id of the webhook, so `id` alone can be the same for two events.
 * - `providerMessageId` is `email_id`, the id of the send answer. `recipient` is `rcpt`.
 */
export function parseSmtp2goEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const value = decodeJsonBytes(body);
  const list = Array.isArray(value) ? value : [value];
  const events: NormalizedEvent[] = [];
  const keys = new Set<string>();
  for (const entry of list) {
    const item = asRecord(entry);
    if (item === undefined) continue;
    const rawType = text(item, "event");
    if (rawType === undefined) continue;
    const emailId = text(item, "email_id");
    const recipient = text(item, "rcpt");
    const eventKey = [
      text(item, "id") ?? "",
      rawType,
      emailId ?? "",
      recipient?.toLowerCase() ?? "",
      text(item, "time") ?? "",
    ].join(":");
    if (keys.has(eventKey)) continue;
    keys.add(eventKey);
    const event: NormalizedEvent = { type: "unknown", provider, eventKey, rawType };
    const bounce = text(item, "bounce");
    if (rawType === "delivered") event.type = "delivered";
    else if (rawType === "spam") event.type = "complained";
    else if (rawType === "unsubscribe") event.type = "unsubscribed";
    else if (rawType === "bounce") {
      event.type = "bounced";
      if (bounce === "hard" || bounce === "soft") event.bounce = bounce;
      const detail = bounceDetail({ text: item.message });
      if (detail !== undefined) event.bounceDetail = detail;
    }
    if (recipient !== undefined) event.recipient = recipient;
    if (emailId !== undefined) event.providerMessageId = emailId;
    const at = millis(item.time);
    if (at !== undefined) event.occurredAt = at;
    events.push(event);
  }
  return events;
}

/**
 * The webhook methods of the SMTP2GO adapter.
 *
 * @throws TypeError for an invalid username or a weak `previousSecret`.
 */
export function smtp2goWebhooks(
  provider: string,
  options: Smtp2goWebhookOptions = {},
): ProviderWebhooks {
  return {
    verify: verifier(options),
    parse: (body) => parseSmtp2goEvents(provider, body),
    signedTimestamp: false,
  };
}
