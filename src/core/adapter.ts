// The provider adapter contract. Each provider subpath exports one adapter. The core
// pipeline, the webhook router, and the conformance kit work only through this type.

import type { FetchLike } from "../internal/http";
import type { NormalizedEvent, WebhookRejection } from "./events";
import { defineProviderMeta, type ProviderMeta } from "./meta";
import type { SocketConnect } from "./socket";
import type { NotSentResult, OutgoingMessage, SendResult, UnknownResult } from "./types";

/** Parsed credentials, by credential field name. */
export type ProviderCredentials = Readonly<Record<string, string>>;

/** What every adapter call gets besides the message. */
export interface SendContext<Creds extends ProviderCredentials = ProviderCredentials> {
  /** Outbound HTTP. Tests pass a mock that replays recorded fixtures. */
  fetch: FetchLike;
  /** The timeout of one provider request, in milliseconds. */
  timeoutMs: number;
  /** The credentials, already checked with `parseCredentials`. */
  credentials: Creds;
  /** The current time, in Unix milliseconds. */
  now: number;
  /** Outbound TCP, for adapters that do not use HTTP (SMTP). HTTP adapters ignore it. */
  connect?: SocketConnect;
}

/** The outcome of `verify`: the credentials work, or why they do not. Switch on `ok`. */
export type VerifyResult =
  | { ok: true }
  | (NotSentResult & { ok: false })
  | (UnknownResult & { ok: false });

/** One webhook request, as `handleWebhook` gives it to an adapter. */
export interface WebhookVerifyInput {
  headers: Headers;
  /** The raw body bytes. Verify the signature over these bytes, not over decoded text. */
  body: Uint8Array;
  /** The signing secret of the webhook endpoint. */
  secret: string;
  /** The current time, in Unix milliseconds. */
  now: number;
  /** Outbound HTTP, for a verifier that fetches a signing certificate (SNS). */
  fetch?: FetchLike;
}

/** The outcome of a webhook signature check. */
export type WebhookVerifyResult = { ok: true } | { ok: false; reason: WebhookRejection };

/** The webhook methods of an adapter. */
export interface ProviderWebhooks {
  /** Checks the signature and the timestamp. It never throws for a bad request. */
  verify(input: WebhookVerifyInput): Promise<WebhookVerifyResult>;
  /**
   * Turns a verified body into normalized events. Each event carries its dedupe key.
   * A body with no events that mailswitch maps gives events of type `unknown`.
   */
  parse(body: Uint8Array, headers: Headers): NormalizedEvent[];
}

/** One email provider. */
export interface ProviderAdapter<Creds extends ProviderCredentials = ProviderCredentials> {
  meta: ProviderMeta;
  /**
   * Sends one message. A provider failure is a result, never an exception. A message
   * that the provider cannot send gives `not_sent/unsupported` with no network call.
   */
  send(message: OutgoingMessage, ctx: SendContext<Creds>): Promise<SendResult>;
  /**
   * Sends up to `meta.capabilities.batchSize` messages in one call. It returns one
   * result per message, in order. The core loops over `send` when it is absent.
   */
  sendBatch?(messages: readonly OutgoingMessage[], ctx: SendContext<Creds>): Promise<SendResult[]>;
  /** Checks that the credentials work, with no email sent. */
  verify(ctx: SendContext<Creds>): Promise<VerifyResult>;
  /** Present when `meta.webhooks` is true. */
  webhooks?: ProviderWebhooks;
}

function fail(id: string, text: string): never {
  throw new TypeError(`Provider "${id}": ${text}`);
}

/**
 * Checks the shape of an adapter and returns it. It throws for a programmer error: bad
 * meta, a missing `send` or `verify`, a `sendBatch` that is not a function, or webhook
 * methods that do not match `meta.webhooks`.
 */
export function defineProvider<Creds extends ProviderCredentials = ProviderCredentials>(
  adapter: ProviderAdapter<Creds>,
): ProviderAdapter<Creds> {
  if (typeof adapter !== "object" || adapter === null) {
    throw new TypeError("defineProvider expects an adapter object.");
  }
  if (typeof adapter.meta !== "object" || adapter.meta === null) {
    throw new TypeError("defineProvider expects an adapter with meta.");
  }
  defineProviderMeta(adapter.meta);
  const id = adapter.meta.id;
  if (typeof adapter.send !== "function") fail(id, "send must be a function.");
  if (typeof adapter.verify !== "function") fail(id, "verify must be a function.");
  if (adapter.sendBatch !== undefined && typeof adapter.sendBatch !== "function") {
    fail(id, "sendBatch must be a function when it is set.");
  }
  const hooks = adapter.webhooks;
  if (hooks !== undefined) {
    if (typeof hooks?.verify !== "function" || typeof hooks.parse !== "function") {
      fail(id, "webhooks must have verify and parse functions.");
    }
    if (adapter.meta.webhooks !== true)
      fail(id, "webhooks are set, but meta.webhooks is not true.");
  } else if (adapter.meta.webhooks === true) {
    fail(id, "meta.webhooks is true, but the adapter has no webhooks methods.");
  }
  return adapter;
}
