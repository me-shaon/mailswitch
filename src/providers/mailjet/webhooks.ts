// Mailjet webhooks (the Event API). Mailjet signs nothing. You put HTTP Basic auth
// credentials in the webhook URL, `https://user:secret@host/path`, and Mailjet sends them
// in the Authorization header. The password is the webhook secret.
// https://dev.mailjet.com/docs/email-api/webhooks/webhooks-overview.md
// https://dev.mailjet.com/docs/email-api/webhooks/event-types.md
//
// Basic auth covers no timestamp and no body. Mailjet retries a failed request every 30 s
// for 24 h. A replayed request passes the check, so the webhook router must dedupe on the
// event key. A changed body also passes the check: the secret only proves that the
// sender knows the password. Use HTTPS for the webhook URL.
//
// Event mapping:
//   sent                      -> delivered (the destination server accepted the message)
//   bounce, hard_bounce true  -> bounced (hard)
//   bounce, other             -> bounced (soft)
//   spam                      -> complained
//   any other event           -> unknown, with the Mailjet name in rawType
//
// Mailjet sends no event id. The event key joins the event name, the MessageID, the
// recipient, and the event time. A click adds its URL. A retry of one delivery gives the
// same key.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent } from "../../core/events";
import { bounceDetail } from "../../internal/bounce-detail";
import { basicAuthorization } from "../../internal/encoding";
import { asRecord, stringField } from "../../internal/json";
import {
  checkSharedTokenSecret,
  generateSharedTokenSecret,
  sharedTokenVerifier,
} from "../../internal/shared-token";

/** The default Basic auth username of a Mailjet webhook. */
export const MAILJET_WEBHOOK_USERNAME = "mailswitch";

/** The options of the Mailjet webhook verifier. */
export interface MailjetWebhookOptions {
  /** The Basic auth username. Defaults to `MAILJET_WEBHOOK_USERNAME`. */
  username?: string;
  /**
   * The secret before a rotation. While it is set, a request with this password also
   * passes. Remove it when Mailjet sends the new secret.
   */
  previousSecret?: string;
}

/**
 * Checks that a webhook secret holds at least 128 bits, as far as its length shows.
 *
 * @throws TypeError for a secret that is too short. The message never holds the secret.
 */
export function checkMailjetWebhookSecret(secret: string): void {
  checkSharedTokenSecret(secret, "Mailjet");
}

/** Makes a webhook secret of 32 random bytes, as 43 base64url characters (256 bits). */
export const generateMailjetWebhookSecret: () => string = generateSharedTokenSecret;

/** The `Authorization` header that Mailjet sends for a username and a webhook secret. */
export function mailjetWebhookAuthorization(
  secret: string,
  username: string = MAILJET_WEBHOOK_USERNAME,
): string {
  return basicAuthorization(username, secret);
}

/**
 * The URL to give Mailjet: the endpoint with the username and the secret in it.
 *
 * @throws TypeError for a URL that is not https, or that has credentials already.
 */
export function mailjetWebhookUrl(
  endpoint: string,
  secret: string,
  username: string = MAILJET_WEBHOOK_USERNAME,
): string {
  const url = URL.parse(endpoint);
  if (url?.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("The Mailjet webhook URL must be an https URL with no credentials.");
  }
  checkMailjetWebhookSecret(secret);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(secret);
  return url.href;
}

const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The text and the JSON value of a body, or undefined when either fails. */
function decode(body: Uint8Array): { text: string; value: unknown } | undefined {
  try {
    const text = fatal.decode(body);
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * Makes the `verify` method. It checks the Basic header with the shared token helper,
 * then checks that the body is one event object (`Version` 1) or a list of them
 * (`Version` 2).
 *
 * @throws TypeError for an invalid username or a weak `previousSecret`.
 */
function verifier(
  options: MailjetWebhookOptions,
): (input: WebhookVerifyInput) => Promise<WebhookVerifyResult> {
  const check = sharedTokenVerifier({
    name: "Mailjet",
    schemes: [{ type: "basic", username: options.username ?? MAILJET_WEBHOOK_USERNAME }],
    ...(options.previousSecret === undefined ? {} : { previousSecret: options.previousSecret }),
  });
  return async (input) => {
    const auth = await check(input.headers, input.secret);
    if (!auth.ok) return auth;
    const value = decode(input.body)?.value;
    const ok = Array.isArray(value)
      ? value.length > 0 && value.every((item) => asRecord(item) !== undefined)
      : asRecord(value) !== undefined;
    return ok ? { ok: true } : { ok: false, reason: "malformed" };
  };
}

const MESSAGE_ID = /"MessageID"\s*:\s*(\d+)/g;

/**
 * Parses a verified Mailjet body: one event object, or a list when grouping is on. An
 * entry with no event name is skipped. A repeated event key is kept once.
 *
 * - `rawType` is the `event` field. `occurredAt` is `time`, in Unix seconds.
 * - `providerMessageId` is `Message_GUID`, else the `MessageID` digits.
 * - `MessageID` is a 64-bit integer, beyond the safe range of a JS number. The parser
 *   takes its raw digits from the body text, in order, so two ids never round together.
 */
export function parseMailjetEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const decoded = decode(body);
  if (decoded === undefined) return [];
  const list = Array.isArray(decoded.value) ? decoded.value : [decoded.value];
  const digits = [...decoded.text.matchAll(MESSAGE_ID)].map((match) => match[1] as string);
  let cursor = 0;
  const events: NormalizedEvent[] = [];
  const keys = new Set<string>();
  for (const entry of list) {
    const item = asRecord(entry);
    if (item === undefined) continue;
    let messageId = stringField(item, "MessageID");
    const id = item.MessageID;
    if (typeof id === "number" && Number.isFinite(id)) {
      // The next raw number with the same value is the one of this entry.
      let at = -1;
      for (let index = cursor; index < digits.length; index++) {
        if (Number(digits[index]) === id) {
          at = index;
          break;
        }
      }
      if (at >= 0) cursor = at + 1;
      messageId = at >= 0 ? (digits[at] as string) : String(id);
    }
    const rawType = stringField(item, "event");
    if (rawType === undefined) continue;
    const recipient = stringField(item, "email");
    const time = item.time;
    const seconds = typeof time === "number" && Number.isFinite(time) ? time : undefined;
    const parts = [rawType, messageId ?? "", recipient?.toLowerCase() ?? "", seconds ?? ""];
    const link = rawType === "click" ? stringField(item, "url") : undefined;
    if (link !== undefined) parts.push(link);
    const eventKey = parts.join(":");
    if (keys.has(eventKey)) continue;
    keys.add(eventKey);
    const event: NormalizedEvent = { type: "unknown", provider, eventKey, rawType };
    if (rawType === "sent") event.type = "delivered";
    else if (rawType === "spam") event.type = "complained";
    else if (rawType === "bounce") {
      event.type = "bounced";
      event.bounce = item.hard_bounce === true ? "hard" : "soft";
      // The Mailjet docs do not confirm these field names, so both stay optional.
      const error = stringField(item, "error");
      const related = stringField(item, "error_related_to");
      const detail = bounceDetail({
        text: error !== undefined && related !== undefined ? `${error} (${related})` : error,
      });
      if (detail !== undefined) event.bounceDetail = detail;
    }
    if (recipient !== undefined) event.recipient = recipient;
    const guid = stringField(item, "Message_GUID") ?? messageId;
    if (guid !== undefined) event.providerMessageId = guid;
    if (seconds !== undefined) event.occurredAt = seconds * 1000;
    events.push(event);
  }
  return events;
}

/**
 * The webhook methods of the Mailjet adapter.
 *
 * @throws TypeError for an invalid username or a weak `previousSecret`.
 */
export function mailjetWebhooks(
  provider: string,
  options: MailjetWebhookOptions = {},
): ProviderWebhooks {
  return {
    verify: verifier(options),
    parse: (body) => parseMailjetEvents(provider, body),
    signedTimestamp: false,
  };
}
