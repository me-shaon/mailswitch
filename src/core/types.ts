// The public message, result, and capability types. Providers, the pipeline, and the
// conformance kit all work through these types.

/** One mailbox. `name` is the display name, for example `Ana from Acme`. */
export interface Address {
  email: string;
  name?: string;
}

/**
 * A mailbox as the caller gives it: an `Address`, a bare email such as `ana@example.com`,
 * or a mailbox string such as `Ana <ana@example.com>`. Each value holds exactly one address.
 */
export type AddressInput = string | Address;

/** One file attached to a message. */
export interface Attachment {
  /** The file name that the recipient sees. It cannot contain a path separator or a quote. */
  filename: string;
  /** The raw bytes, or the bytes as padded, standard-alphabet base64 text. */
  content: Uint8Array | string;
  /** A MIME type in `type/subtype` form, with no parameters. For example `application/pdf`. */
  contentType: string;
  /** Set for an inline image. The HTML refers to it as `cid:<contentId>`. */
  contentId?: string;
}

/** One transactional email. */
export interface OutgoingMessage {
  from: AddressInput;
  /** One or more recipients. */
  to: readonly AddressInput[];
  cc?: readonly AddressInput[];
  bcc?: readonly AddressInput[];
  replyTo?: AddressInput;
  subject: string;
  /** At least one of `html` and `text` must be a non-empty string. */
  html?: string;
  text?: string;
  /** Extra headers, sent unchanged. Structural headers such as `Bcc` are refused. */
  headers?: Readonly<Record<string, string>>;
  attachments?: readonly Attachment[];
  /**
   * A stable key for this email. A retry with the same key never sends a second copy,
   * when the provider has native idempotency or the mailer has an idempotency store.
   */
  idempotencyKey?: string;
}

/**
 * The delivery status of one send.
 * - `sent`: the provider accepted the message.
 * - `not_sent`: the message did not go out, so a retry or a fallback cannot send a duplicate.
 * - `unknown`: the message may have gone out. Never retry or fall back after `unknown`.
 */
export type DeliveryStatus = "sent" | "not_sent" | "unknown";

/** Why a send failed. */
export type FailureReason =
  /** The provider refused the credentials. */
  | "auth"
  /** The provider asked the caller to slow down. */
  | "rate_limited"
  /** A provider sending quota is used up. */
  | "quota"
  /** The account has no credits left. */
  | "credits"
  /** The provider refused this message or recipient. */
  | "rejected"
  /** The request started and did not finish in time. */
  | "timeout"
  /** The request failed at the network level. */
  | "network"
  /** The message breaks a validation rule. */
  | "invalid_message"
  /** The provider failed on its side, for example with a 5xx response. */
  | "provider_error"
  /** The provider cannot send this message, for example because it has attachments. */
  | "unsupported"
  /** The daily cap of the provider is reached. */
  | "daily_cap"
  /** The idempotency key was used before with a different message. */
  | "idempotency_conflict"
  /** A claim for the idempotency key did not finish in time. The earlier send may have gone out. */
  | "stale_pending"
  /** Another request holds a claim for the same key now. */
  | "in_flight";

/** A successful send. */
export interface SentResult {
  status: "sent";
  /** The id that the provider gave the message, when it returns one. */
  providerMessageId?: string;
  /** The id of the provider that sent the message. */
  provider?: string;
}

/** Fields that every failed send carries. */
export interface FailureFields {
  reason: FailureReason;
  /** A short, safe description. It never contains secrets, recipients, or provider response bodies. */
  message: string;
  /** How long to wait before a retry, in milliseconds, when it is known. */
  retryAfterMs?: number;
  /** The HTTP status of the provider response, when there was one. */
  httpStatus?: number;
  /** The id of the provider that produced this result. */
  provider?: string;
}

/** A send that did not go out. A retry or a fallback is safe. */
export interface NotSentResult extends FailureFields {
  status: "not_sent";
  /** For `daily_cap`: when the cap has room again, in Unix milliseconds. */
  resetAt?: number;
}

/** A send that may have gone out. Do not retry it and do not fall back. */
export interface UnknownResult extends FailureFields {
  status: "unknown";
}

/** The result of one send. Switch on `status`. */
export type SendResult = SentResult | NotSentResult | UnknownResult;

/** What a provider can send. mailswitch refuses a message that needs more, before any network call. */
export interface Capabilities {
  /** The provider accepts attachments. */
  attachments: boolean;
  /** The largest message after base64 encoding, in bytes. Null when the provider states no limit. */
  maxMessageBytes: number | null;
  cc: boolean;
  bcc: boolean;
  replyTo: boolean;
  /** The provider passes custom headers through unchanged. */
  customHeaders: boolean;
  /** The provider accepts an idempotency key and drops a repeat. */
  idempotency: boolean;
  /** Messages per batch call. 1 when the provider has no batch endpoint. */
  batchSize: number;
  /** The largest number of recipients across to, cc, and bcc. Omit for no limit. */
  maxRecipients?: number;
}
