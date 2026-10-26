// Normalized webhook events and the typed reasons for a refused webhook. Every adapter
// turns its provider's webhook body into these types, so an app handles one shape.

/** The kinds of normalized events. A type that mailswitch does not map is `unknown`. */
export type NormalizedEventType = "bounced" | "complained" | "delivered" | "unknown";

/** Every normalized event type, in a fixed order. */
export const NORMALIZED_EVENT_TYPES: readonly NormalizedEventType[] = [
  "bounced",
  "complained",
  "delivered",
  "unknown",
];

/** One provider event in the shared shape. */
export interface NormalizedEvent {
  type: NormalizedEventType;
  /** For `bounced` only: `hard` for a permanent failure, `soft` for a temporary one. */
  bounce?: "hard" | "soft";
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
 */
export type WebhookRejection =
  | "bad_signature"
  | "stale"
  | "malformed"
  | "too_large"
  | "body_used"
  | "replay"
  | "in_flight"
  | "untrusted_topic";

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
];
