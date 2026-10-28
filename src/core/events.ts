// Normalized webhook events and the typed reasons for a refused webhook. Every adapter
// turns its provider's webhook body into these types, so an app handles one shape.

/**
 * The kinds of normalized events. A type that mailswitch does not map is `unknown`.
 *
 * A minor release can add a type. Give each `switch` on this type a `default` case.
 */
export type NormalizedEventType = "bounced" | "complained" | "delivered" | "unknown";

/** Every normalized event type, in a fixed order. */
export const NORMALIZED_EVENT_TYPES: readonly NormalizedEventType[] = [
  "bounced",
  "complained",
  "delivered",
  "unknown",
];

/**
 * The reason for a bounce, as the provider sends it. mailswitch removes control and
 * invisible characters from the text, trims it, and cuts it at 1,000 UTF-16 code units.
 * It never reads a code out of the text.
 */
export interface BounceDetail {
  /** The reason text from the remote mail server or the provider. */
  text?: string;
  /** The SMTP reply code, an integer from 200 to 599. */
  smtpCode?: number;
  /** The enhanced status code, for example `5.1.1`. */
  enhancedCode?: string;
}

/** One provider event in the shared shape. */
export interface NormalizedEvent {
  type: NormalizedEventType;
  /** For `bounced` only: `hard` for a permanent failure, `soft` for a temporary one. */
  bounce?: "hard" | "soft";
  /**
   * For `bounced` only: the reason that the provider gives for the bounce. It is set only
   * when the provider sends at least one part. The text comes from a remote mail server
   * and can hold personal data. mailswitch does not escape markup in it. Escape the text
   * for your output (HTML, Markdown, or email) before you show it.
   */
  bounceDetail?: BounceDetail;
  /** The address that the event is about. */
  recipient?: string;
  /** The id that the provider gave the message at send time. */
  providerMessageId?: string;
  /** When the provider says the event happened, in Unix milliseconds. */
  occurredAt?: number;
  /** The id of the provider that sent the event. */
  provider: string;
  /**
   * The dedupe key of the event. It is stable across retries of the same delivery and
   * differs between two real events, for example two soft bounces of one message.
   */
  eventKey: string;
  /** The event type exactly as the provider names it. */
  rawType: string;
}

/**
 * Why a webhook was refused.
 * - `bad_signature`: the signature is missing, malformed, or wrong.
 * - `stale`: the signed timestamp is outside the allowed window.
 * - `malformed`: the body or a required header cannot be parsed.
 * - `too_large`: the body is larger than the size cap.
 * - `body_used`: the request body was read before mailswitch got it.
 * - `replay`: the event key was handled before.
 * - `in_flight`: another request holds a claim for the same event key now.
 * - `untrusted_topic`: the SNS topic is not in the allowlist.
 * - `invalid_secret`: the configured secret is too short or has the wrong form. This is a
 *   setup error on the receiving side, not a bad request.
 *
 * A minor release can add a code. Give each `switch` on this type a `default` case, and use
 * `REJECTION_STATUS` for the HTTP status of a code.
 */
export type WebhookRejection =
  | "bad_signature"
  | "stale"
  | "malformed"
  | "too_large"
  | "body_used"
  | "replay"
  | "in_flight"
  | "untrusted_topic"
  | "invalid_secret";

/** Every webhook rejection code, in a fixed order. */
export const WEBHOOK_REJECTIONS: readonly WebhookRejection[] = [
  "bad_signature",
  "stale",
  "malformed",
  "too_large",
  "body_used",
  "replay",
  "in_flight",
  "untrusted_topic",
  "invalid_secret",
];
