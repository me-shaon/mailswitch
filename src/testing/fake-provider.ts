// A fake provider for tests. In the default `memory` transport it makes no network call:
// it records each send and returns the outcome that the test configures. In the `fetch`
// transport it talks to a fake HTTP API through `ctx.fetch`, so the conformance kit can
// drive it with recorded exchanges. The fake API host ends in `.invalid`, which never
// resolves, so a fetch-mode call that escapes a mock fails as `unknown/network`.

import type {
  ProviderAdapter,
  SendContext,
  VerifyResult,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from "../core/adapter";
import { classifyResponse, defineStatusMap } from "../core/classify";
import type { NormalizedEvent, NormalizedEventType } from "../core/events";
import { validateMessage } from "../core/message";
import { defineProviderMeta, type ProviderMeta } from "../core/meta";
import type {
  AddressInput,
  NotSentResult,
  OutgoingMessage,
  SendResult,
  UnknownResult,
} from "../core/types";
import { formatAddress, parseAddress } from "../internal/address";
import { bytesToBase64, utf8 } from "../internal/encoding";
import { hmacVerify } from "../internal/hmac";
import { callProvider, discardBody, readJson } from "../internal/http";
import { decodeJsonBytes, hexToBytes } from "../internal/webhook-bytes";

/** The base URL of the fake HTTP API. */
export const FAKE_API_BASE = "https://api.fake-provider.invalid/v1";
/** The header that carries the fake webhook signature: `t=<seconds>,v1=<hex HMAC-SHA256>`. */
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
/** The signature window of the fake webhook, in milliseconds. */
export const FAKE_WEBHOOK_TOLERANCE_MS: number = 5 * 60 * 1000;

const CONFLICT_SOURCE =
  "https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/";

/** The outcome of one fake send in the memory transport. */
export type FakeOutcome = "sent" | "not_sent" | "unknown" | SendResult;

/** Options of `fakeProvider`. */
export interface FakeProviderOptions {
  /** The provider id. Defaults to `fake`. */
  id?: string;
  /**
   * `memory` (the default) records sends and makes no network call. `fetch` sends each
   * message to the fake HTTP API through `ctx.fetch`.
   */
  transport?: "memory" | "fetch";
  /**
   * The memory transport outcomes: a list in call order, or a function of the message
   * and the call index. A call past the end of the list, or with no option, is `sent`.
   */
  outcomes?: readonly FakeOutcome[] | ((message: OutgoingMessage, call: number) => FakeOutcome);
  /** The memory transport result of `verify`. Defaults to `{ ok: true }`. */
  verifyResult?: VerifyResult;
}

/** One send that reached the fake transport. */
export interface FakeSend {
  message: OutgoingMessage;
  result: SendResult;
  /** The context time of the send, in Unix milliseconds. */
  at: number;
}

/** The fake adapter, with what it recorded. */
export interface FakeProvider extends ProviderAdapter {
  /** Every send that passed validation, in order. Refused messages are not recorded. */
  readonly sends: FakeSend[];
  /** Clears `sends` and restarts the outcome list. */
  reset(): void;
}

/** The meta of a fake provider: tier 1, every capability, native idempotency, webhooks. */
export function fakeMeta(id = "fake"): ProviderMeta {
  return defineProviderMeta({
    id,
    name: "Fake provider",
    tier: 1,
    capabilities: {
      attachments: true,
      maxMessageBytes: 10_000_000,
      cc: true,
      bcc: true,
      replyTo: true,
      customHeaders: true,
      idempotency: true,
      batchSize: 1,
      maxRecipients: 50,
    },
    credentialFields: [
      {
        name: "apiKey",
        label: "API key",
        secret: true,
        required: true,
        placeholder: "fk_...",
        pattern: "^fk_[A-Za-z0-9]+$",
      },
    ],
    docsUrl: "https://api.fake-provider.invalid/docs",
    statusMap: defineStatusMap({
      // A request with this key is in progress or used with another payload.
      409: { status: "unknown", reason: "idempotency_conflict", source: CONFLICT_SOURCE },
    }),
    webhooks: true,
    nativeIdempotency: true,
  });
}

function outcomeResult(outcome: FakeOutcome, provider: string, call: number): SendResult {
  if (typeof outcome === "object") return { ...outcome, provider: outcome.provider ?? provider };
  if (outcome === "sent") {
    return { status: "sent", providerMessageId: `${provider}-${call + 1}`, provider };
  }
  if (outcome === "not_sent") {
    return {
      status: "not_sent",
      reason: "rejected",
      message: "The fake provider refused the message.",
      provider,
    };
  }
  return {
    status: "unknown",
    reason: "provider_error",
    message: "The fake provider failed after the request.",
    provider,
  };
}

function address(input: AddressInput): string {
  const parsed = parseAddress(input);
  return parsed ? formatAddress(parsed) : "";
}

function requestBody(message: OutgoingMessage): string {
  return JSON.stringify({
    from: address(message.from),
    to: message.to.map(address),
    cc: message.cc?.map(address),
    bcc: message.bcc?.map(address),
    reply_to: message.replyTo === undefined ? undefined : address(message.replyTo),
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
    attachments: message.attachments?.map((item) => ({
      filename: item.filename,
      content_type: item.contentType,
      content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
      content_id: item.contentId,
    })),
  });
}

function withProvider<T extends NotSentResult | UnknownResult>(result: T, provider: string): T {
  return { ...result, provider };
}

async function httpSend(
  meta: ProviderMeta,
  message: OutgoingMessage,
  ctx: SendContext,
): Promise<SendResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.credentials.apiKey ?? ""}`,
    "content-type": "application/json",
  };
  if (message.idempotencyKey !== undefined) headers["idempotency-key"] = message.idempotencyKey;
  const call = await callProvider({
    url: `${FAKE_API_BASE}/emails`,
    headers,
    body: requestBody(message),
    timeoutMs: ctx.timeoutMs,
    fetch: ctx.fetch,
  });
  if (!call.ok) return withProvider(call.result, meta.id);
  const outcome = classifyResponse(call.response.status, call.response.headers, meta.statusMap, {
    now: ctx.now,
  });
  if (outcome.status !== "sent") {
    await discardBody(call.response);
    return withProvider(outcome, meta.id);
  }
  const json = await readJson(call.response);
  const id = (json as { id?: unknown } | null)?.id;
  return {
    status: "sent",
    provider: meta.id,
    ...(typeof id === "string" ? { providerMessageId: id } : {}),
  };
}

async function httpVerify(meta: ProviderMeta, ctx: SendContext): Promise<VerifyResult> {
  const call = await callProvider({
    url: `${FAKE_API_BASE}/account`,
    method: "GET",
    headers: { authorization: `Bearer ${ctx.credentials.apiKey ?? ""}` },
    timeoutMs: ctx.timeoutMs,
    fetch: ctx.fetch,
  });
  if (!call.ok) return { ...withProvider(call.result, meta.id), ok: false };
  await discardBody(call.response);
  const outcome = classifyResponse(call.response.status, call.response.headers, meta.statusMap, {
    now: ctx.now,
  });
  return outcome.status === "sent"
    ? { ok: true }
    : { ...withProvider(outcome, meta.id), ok: false };
}

/** The bytes that the fake webhook signs: `<seconds>.` followed by the raw body. */
export function fakeSignedPayload(seconds: number, body: Uint8Array): Uint8Array {
  const prefix = utf8(`${seconds}.`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

async function verifyWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const header = input.headers.get(FAKE_SIGNATURE_HEADER);
  if (header === null) return { ok: false, reason: "bad_signature" };
  const parts = new Map<string, string>();
  for (const part of header.split(",")) {
    const cut = part.indexOf("=");
    if (cut > 0) parts.set(part.slice(0, cut).trim(), part.slice(cut + 1).trim());
  }
  const seconds = Number(parts.get("t"));
  const signature = hexToBytes(parts.get("v1") ?? "");
  if (!Number.isSafeInteger(seconds) || signature === null || signature.length !== 32) {
    return { ok: false, reason: "malformed" };
  }
  const valid = await hmacVerify(input.secret, signature, fakeSignedPayload(seconds, input.body));
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (Math.abs(input.now - seconds * 1000) > FAKE_WEBHOOK_TOLERANCE_MS) {
    return { ok: false, reason: "stale" };
  }
  return decodeJsonBytes(input.body) === undefined
    ? { ok: false, reason: "malformed" }
    : { ok: true };
}

interface FakeEvent {
  id?: unknown;
  type?: unknown;
  recipient?: unknown;
  message_id?: unknown;
  occurred_at?: unknown;
  bounce_type?: unknown;
}

const EVENT_TYPES: Readonly<Record<string, NormalizedEventType>> = {
  bounce: "bounced",
  complaint: "complained",
  delivered: "delivered",
};

function parseWebhook(provider: string, body: Uint8Array): NormalizedEvent[] {
  const list = (decodeJsonBytes(body) as { events?: unknown } | null)?.events;
  if (!Array.isArray(list)) return [];
  const events: NormalizedEvent[] = [];
  for (const item of list as FakeEvent[]) {
    if (typeof item?.id !== "string" || typeof item.type !== "string") continue;
    const type = EVENT_TYPES[item.type] ?? "unknown";
    const event: NormalizedEvent = { type, provider, eventKey: item.id, rawType: item.type };
    if (type === "bounced") event.bounce = item.bounce_type === "soft" ? "soft" : "hard";
    if (typeof item.recipient === "string") event.recipient = item.recipient;
    if (typeof item.message_id === "string") event.providerMessageId = item.message_id;
    if (typeof item.occurred_at === "string") {
      const at = Date.parse(item.occurred_at);
      if (Number.isFinite(at)) event.occurredAt = at;
    }
    events.push(event);
  }
  return events;
}

/** Creates a fake provider. See `FakeProviderOptions`. */
export function fakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const meta = fakeMeta(options.id);
  const transport = options.transport ?? "memory";
  const sends: FakeSend[] = [];
  let calls = 0;

  function memoryOutcome(message: OutgoingMessage): SendResult {
    const call = calls++;
    const source = options.outcomes;
    const outcome =
      typeof source === "function" ? source(message, call) : (source?.[call] ?? "sent");
    return outcomeResult(outcome, meta.id, call);
  }

  return {
    meta,
    sends,
    reset() {
      sends.length = 0;
      calls = 0;
    },
    async send(message, ctx) {
      const checked = validateMessage(message, meta.capabilities);
      if (!checked.ok) return withProvider(checked.result, meta.id);
      const result =
        transport === "fetch" ? await httpSend(meta, message, ctx) : memoryOutcome(message);
      sends.push({ message, result, at: ctx.now });
      return result;
    },
    async verify(ctx) {
      if (transport === "fetch") return httpVerify(meta, ctx);
      return options.verifyResult ?? { ok: true };
    },
    webhooks: {
      verify: verifyWebhook,
      parse: (body) => parseWebhook(meta.id, body),
    },
  };
}
