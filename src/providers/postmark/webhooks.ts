// Postmark webhooks. Postmark does not sign webhooks. It sends the HTTP Basic auth
// credentials that you set on the webhook, so the password is the webhook secret.
// https://postmarkapp.com/developer/webhooks/webhooks-overview
// https://postmarkapp.com/developer/webhooks/bounce-webhook
// https://postmarkapp.com/developer/webhooks/delivery-webhook
// https://postmarkapp.com/developer/webhooks/spam-complaint-webhook
//
// Basic auth covers no timestamp and no body. A replayed request passes the check, so the
// webhook router must dedupe on the event key. A changed body also passes the check: the
// secret only proves that the sender knows the password. Use HTTPS for the webhook URL.

import type { ProviderWebhooks, WebhookVerifyInput, WebhookVerifyResult } from "../../core/adapter";
import type { NormalizedEvent, NormalizedEventType } from "../../core/events";
import { base64ToBytes, bytesToBase64, utf8 } from "../../internal/encoding";
import { decodeJsonBytes, timingSafeEqualText } from "../../internal/webhook-bytes";

/** The default Basic auth username of a Postmark webhook. */
export const POSTMARK_WEBHOOK_USERNAME = "mailswitch";
/** The shortest webhook secret, in characters, when it is not hex only. 22 base64url characters hold 128 bits. */
export const POSTMARK_MIN_SECRET_LENGTH = 22;
/** The shortest webhook secret that holds only hex characters. 32 hex characters hold 128 bits. */
export const POSTMARK_MIN_HEX_SECRET_LENGTH = 32;

const HEX_ONLY = /^[0-9a-fA-F]+$/;
const AUTHORIZATION = /^([A-Za-z]+) +([A-Za-z0-9+/=]+) *$/;
const USERNAME = /^[\x21-\x39\x3b-\x7e]{1,128}$/;

/**
 * Checks that a webhook secret holds at least 128 bits of entropy, as far as its length
 * shows: 22 characters, or 32 characters for a hex-only secret. Make the secret with
 * `generatePostmarkWebhookSecret`. A long secret of one repeated character also passes,
 * so do not type a secret by hand.
 *
 * @throws TypeError for a secret that is too short. The message never holds the secret.
 */
export function checkPostmarkWebhookSecret(secret: string): void {
  if (!isStrongSecret(secret)) {
    throw new TypeError("The Postmark webhook secret is too short: it needs 128 bits.");
  }
}

function isStrongSecret(secret: string): boolean {
  if (typeof secret !== "string") return false;
  const min = HEX_ONLY.test(secret) ? POSTMARK_MIN_HEX_SECRET_LENGTH : POSTMARK_MIN_SECRET_LENGTH;
  return secret.length >= min;
}

/** Makes a webhook secret of 32 random bytes, as 43 base64url characters (256 bits). */
export function generatePostmarkWebhookSecret(): string {
  const text = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  return text.replace(/[+/=]/g, (c) => (c === "+" ? "-" : c === "/" ? "_" : ""));
}

/** The `Authorization` header that Postmark sends for a username and a webhook secret. */
export function postmarkWebhookAuthorization(
  secret: string,
  username: string = POSTMARK_WEBHOOK_USERNAME,
): string {
  return `Basic ${bytesToBase64(utf8(`${username}:${secret}`))}`;
}

const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function decodeText(body: Uint8Array): string | undefined {
  try {
    return fatal.decode(body);
  } catch {
    return undefined;
  }
}

/** The options of the Postmark webhook verifier. */
export interface PostmarkWebhookOptions {
  /** The Basic auth username. Defaults to `POSTMARK_WEBHOOK_USERNAME`. */
  username?: string;
  /**
   * The secret before a rotation. While it is set, a request with this password also
   * passes. Remove it when Postmark sends the new secret.
   */
  previousSecret?: string;
}

/**
 * Makes the `verify` method. It parses the scheme without regard to case, and it compares
 * the SHA-256 digests of the username and of the password, each in constant time.
 *
 * @throws TypeError for an invalid username or a weak `previousSecret`.
 */
function verifier(
  options: PostmarkWebhookOptions,
): (input: WebhookVerifyInput) => Promise<WebhookVerifyResult> {
  const username = options.username ?? POSTMARK_WEBHOOK_USERNAME;
  if (!USERNAME.test(username)) {
    throw new TypeError("The Postmark webhook username is empty or has a colon or a space.");
  }
  const previous = options.previousSecret;
  if (previous !== undefined) checkPostmarkWebhookSecret(previous);

  return async (input) => {
    if (input.secret === "") return { ok: false, reason: "bad_signature" };
    // A weak secret is a setup error on this side. It is not the sender's fault.
    if (!isStrongSecret(input.secret)) return { ok: false, reason: "invalid_secret" };
    const header = input.headers.get("authorization");
    if (header === null) return { ok: false, reason: "bad_signature" };
    const match = AUTHORIZATION.exec(header.trim());
    if (!match) return { ok: false, reason: "malformed" };
    if ((match[1] as string).toLowerCase() !== "basic") {
      return { ok: false, reason: "bad_signature" };
    }
    const bytes = base64ToBytes(match[2] as string);
    const pair = bytes === null ? undefined : decodeText(bytes);
    const cut = pair?.indexOf(":") ?? -1;
    if (pair === undefined || cut < 0) return { ok: false, reason: "malformed" };
    const pass = pair.slice(cut + 1);
    // All three comparisons run before the result is combined.
    const [userOk, passOk, previousOk] = await Promise.all([
      timingSafeEqualText(pair.slice(0, cut), username),
      timingSafeEqualText(pass, input.secret),
      timingSafeEqualText(pass, previous ?? input.secret),
    ]);
    if (!(userOk && (passOk || previousOk))) return { ok: false, reason: "bad_signature" };
    const value = decodeJsonBytes(input.body);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, reason: "malformed" };
    }
    return { ok: true };
  };
}

type Fields = Record<string, unknown>;

function text(record: Fields, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Bounce types that mean the address does not work. https://postmarkapp.com/developer/api/bounce-api#bounce-types */
const HARD_BOUNCES: ReadonlySet<string> = new Set([
  "HardBounce",
  "BadEmailAddress",
  "ManuallyDeactivated",
]);
/** Bounce types that may work later. Other bounce types, such as AutoResponder, are `unknown`. */
const SOFT_BOUNCES: ReadonlySet<string> = new Set(["Transient", "DnsError", "SoftBounce"]);

function bounceKind(record: Fields): "hard" | "soft" | undefined {
  const type = text(record, "Type") ?? "";
  if (HARD_BOUNCES.has(type)) return "hard";
  if (SOFT_BOUNCES.has(type)) return "soft";
  return undefined;
}

/**
 * The digits of the top-level `ID`. A bounce ID is a 64-bit integer, beyond the safe
 * range of a JS number. The raw digits keep two IDs that round to one number apart.
 */
function eventId(body: string, record: Fields): string | undefined {
  const id = record.ID;
  if (typeof id === "string" && id !== "") return id;
  if (typeof id !== "number" || !Number.isFinite(id)) return undefined;
  for (const match of body.matchAll(/"ID"\s*:\s*(\d+)/g)) {
    if (Number(match[1]) === id) return match[1];
  }
  return String(id);
}

/**
 * Parses a verified Postmark body. One body holds one event.
 *
 * - `Bounce` maps to `bounced`, hard or soft by the bounce type. A bounce type that is
 *   neither, such as `AutoResponder`, gives `unknown`.
 * - `SpamComplaint` maps to `complained`. `Delivery` maps to `delivered`. Every other
 *   record type gives `unknown`.
 * - `rawType` is the `RecordType`.
 * - The event key is `RecordType:ID` for a record with an ID (Bounce, SpamComplaint).
 *   A Delivery has no ID: its key is `Delivery:MessageID:recipient`, because Postmark
 *   reports one delivery for each recipient of a message. Any other record without an
 *   ID (Open, Click, SubscriptionChange) gets `RecordType:MessageID:recipient:time`, and
 *   a Click adds its link. These fields stay the same across retries of one request.
 *   mailswitch does not hash the body here: a synchronous SHA-256 would double the
 *   size of this subpath for event types that mailswitch does not map.
 */
export function parsePostmarkEvents(provider: string, body: Uint8Array): NormalizedEvent[] {
  const raw = decodeText(body);
  const value = decodeJsonBytes(body);
  if (raw === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const record = value as Fields;
  const rawType = text(record, "RecordType") ?? "unknown";
  const bounce = rawType === "Bounce" ? bounceKind(record) : undefined;
  const type: NormalizedEventType = bounce
    ? "bounced"
    : rawType === "Delivery"
      ? "delivered"
      : rawType === "SpamComplaint"
        ? "complained"
        : "unknown";
  const recipient = text(record, "Email") ?? text(record, "Recipient");
  const messageId = text(record, "MessageID");
  const time =
    text(record, "BouncedAt") ??
    text(record, "DeliveredAt") ??
    text(record, "ReceivedAt") ??
    text(record, "ChangedAt");
  const id = eventId(raw, record);
  const parts = [rawType, messageId, recipient?.toLowerCase()];
  if (rawType !== "Delivery") parts.push(time, text(record, "OriginalLink"));
  const eventKey =
    id === undefined ? parts.filter((part) => part !== undefined).join(":") : `${rawType}:${id}`;
  const event: NormalizedEvent = { type, provider, eventKey, rawType };
  if (bounce !== undefined) event.bounce = bounce;
  if (recipient !== undefined) event.recipient = recipient;
  if (messageId !== undefined) event.providerMessageId = messageId;
  const at = Date.parse(time ?? "");
  if (Number.isFinite(at)) event.occurredAt = at;
  return [event];
}

/**
 * The webhook methods of the Postmark adapter.
 *
 * @throws TypeError for an invalid username or a weak `previousSecret`.
 */
export function postmarkWebhooks(
  provider: string,
  options: PostmarkWebhookOptions = {},
): ProviderWebhooks {
  return {
    verify: verifier(options),
    parse: (body) => parsePostmarkEvents(provider, body),
    signedTimestamp: false,
  };
}
