// The Lettermill adapter: the scaffold output with the stub filled in. Lettermill is
// fictional. Its API (https://lettermill.example/docs/api) has these parts:
//
// - POST /v1/messages sends one email. Auth is the `X-Lettermill-Key` header. A 200 gives
//   `{ "id": "lm_msg_..." }`. A failure gives `{ "error": { "code", "message" } }`.
// - GET /v1/account reads the account. It sends no email.
// - Webhooks sign `<timestamp>.<raw body>` with HMAC-SHA256. The headers are
//   `Lettermill-Timestamp` (Unix seconds) and `Lettermill-Signature` (`v1=<hex>`).

import { validateMessage } from "../../../src/core/message";
import type {
  AddressInput,
  NotSentResult,
  OutgoingMessage,
  SendResult,
  UnknownResult,
} from "../../../src/core/types";
import {
  bytesToBase64,
  bytesToHex,
  callProvider,
  classifyResponse,
  defineProvider,
  discardBody,
  hmacSign,
  hmacVerify,
  type NormalizedEvent,
  type NormalizedEventType,
  type ProviderAdapter,
  type ProviderWebhooks,
  readJson,
  type SendContext,
  utf8,
  type VerifyResult,
  type WebhookVerifyInput,
  type WebhookVerifyResult,
} from "../../../src/provider-kit/index";
import { lettermillMeta } from "./meta";

export { lettermillMeta } from "./meta";

/** The Lettermill API origin. */
export const LETTERMILL_API_BASE = "https://api.lettermill.example";
/** Lettermill refuses a webhook timestamp that is more than 5 minutes off. */
export const LETTERMILL_WEBHOOK_WINDOW_MS: number = 5 * 60 * 1000;

/** Options of `lettermill`. */
export interface LettermillOptions {
  /** The API key. The key in `SendContext.credentials` takes precedence. */
  apiKey?: string;
  /** The API origin. Tests and proxies change it. */
  baseUrl?: string;
}

interface LettermillError {
  error?: { code?: unknown };
}

const PROVIDER = lettermillMeta.id;

function tag<T extends NotSentResult | UnknownResult>(result: T): T {
  return { ...result, provider: PROVIDER };
}

/** One address as header text. `validateMessage` has already checked it. */
function address(input: AddressInput): string {
  if (typeof input === "string") return input;
  if (!input.name) return input.email;
  return `"${input.name.replace(/(["\\])/g, "\\$1")}" <${input.email}>`;
}

/** The JSON body of one send request. */
export function lettermillPayload(message: OutgoingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: address(message.from),
    to: message.to.map(address),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(address);
  if (message.bcc?.length) body.bcc = message.bcc.map(address);
  if (message.replyTo !== undefined) body.reply_to = address(message.replyTo);
  if (message.html !== undefined) body.html = message.html;
  if (message.text !== undefined) body.text = message.text;
  if (message.headers && Object.keys(message.headers).length > 0) body.headers = message.headers;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((item) => ({
      filename: item.filename,
      content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
      content_type: item.contentType,
    }));
  }
  return body;
}

/**
 * Refines the reason of a `not_sent` result with the Lettermill error code. The status
 * never changes, and the message never copies the response body.
 */
function refine(result: NotSentResult, error: LettermillError | null): NotSentResult {
  const code = error?.error?.code;
  const reason = code === "suppressed" ? "rejected" : code === "quota_exceeded" ? "quota" : null;
  if (reason === null) return result;
  return {
    ...result,
    reason,
    message: `The provider answered with HTTP ${result.httpStatus} (${reason}).`,
  };
}

// Webhooks.

/** The bytes that Lettermill signs: `<timestamp>.` and the raw body. */
export function lettermillSignedPayload(timestamp: string, body: Uint8Array): Uint8Array {
  const head = utf8(`${timestamp}.`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** The `Lettermill-Signature` value of a body. The fixture signs with it too. */
export async function lettermillSignature(
  secret: string,
  timestamp: string,
  body: Uint8Array,
): Promise<string> {
  return `v1=${bytesToHex(await hmacSign(secret, lettermillSignedPayload(timestamp, body)))}`;
}

const SIGNATURE = /^v1=([0-9a-f]{64})$/;
const TIMESTAMP = /^\d{1,12}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    ) as unknown;
  } catch {
    return undefined;
  }
}

async function verifyWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const timestamp = input.headers.get("lettermill-timestamp");
  const header = input.headers.get("lettermill-signature");
  if (timestamp === null || header === null) return { ok: false, reason: "bad_signature" };
  const match = SIGNATURE.exec(header.trim());
  if (!TIMESTAMP.test(timestamp) || !match) return { ok: false, reason: "malformed" };
  // Check the signature over the raw bytes with crypto.subtle.verify (constant time).
  const signed = lettermillSignedPayload(timestamp, input.body);
  if (!(await hmacVerify(input.secret, hexToBytes(match[1] as string), signed))) {
    return { ok: false, reason: "bad_signature" };
  }
  // Refuse a timestamp outside the window, in the past and in the future.
  if (Math.abs(input.now - Number(timestamp) * 1000) > LETTERMILL_WEBHOOK_WINDOW_MS) {
    return { ok: false, reason: "stale" };
  }
  const value = decodeJson(input.body);
  if (typeof value !== "object" || value === null) return { ok: false, reason: "malformed" };
  return { ok: true };
}

const TYPES: Readonly<Record<string, NormalizedEventType>> = {
  "message.delivered": "delivered",
  "message.bounced": "bounced",
  "message.complained": "complained",
};

type Fields = Record<string, unknown>;

function text(record: Fields | undefined, name: string): string | undefined {
  const value = record?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parses a verified body. Lettermill sends one event per request, with a unique `id`.
 * The id is the event key, so a retry of one delivery gives the same key. A body with no
 * id gives no event.
 */
function parseEvents(body: Uint8Array): NormalizedEvent[] {
  const value = decodeJson(body);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Fields;
  const eventKey = text(record, "id");
  if (eventKey === undefined) return [];
  const data =
    typeof record.data === "object" && record.data !== null ? (record.data as Fields) : undefined;
  const rawType = text(record, "type") ?? "unknown";
  const type = TYPES[rawType] ?? "unknown";
  const event: NormalizedEvent = { type, provider: PROVIDER, eventKey, rawType };
  if (type === "bounced") event.bounce = text(data, "bounce_kind") === "soft" ? "soft" : "hard";
  const recipient = text(data, "recipient");
  if (recipient !== undefined) event.recipient = recipient;
  const messageId = text(data, "message_id");
  if (messageId !== undefined) event.providerMessageId = messageId;
  const at = Date.parse(text(record, "created_at") ?? "");
  if (Number.isFinite(at)) event.occurredAt = at;
  return [event];
}

const webhooks: ProviderWebhooks = { verify: verifyWebhook, parse: parseEvents };

/** Creates the Lettermill adapter. Throws a TypeError for invalid options. */
export function lettermill(options: LettermillOptions = {}): ProviderAdapter {
  const base = (options.baseUrl ?? LETTERMILL_API_BASE).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    throw new TypeError("lettermill: baseUrl must be an http or https URL.");
  }

  function headers(ctx: SendContext): Record<string, string> {
    return {
      "x-lettermill-key": ctx.credentials.apiKey || options.apiKey || "",
      "content-type": "application/json",
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, lettermillMeta.capabilities);
    if (!checked.ok) return tag(checked.result);
    const call = await callProvider({
      url: `${base}/v1/messages`,
      headers: headers(ctx),
      body: JSON.stringify(lettermillPayload(message)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return tag(call.result);
    const response = call.response;
    const outcome = classifyResponse(response.status, response.headers, lettermillMeta.statusMap, {
      now: ctx.now,
    });
    if (outcome.status === "unknown") {
      await discardBody(response);
      return tag(outcome);
    }
    if (outcome.status === "not_sent") {
      return tag(refine(outcome, (await readJson(response)) as LettermillError | null));
    }
    const id = ((await readJson(response)) as { id?: unknown } | null)?.id;
    return {
      status: "sent",
      provider: PROVIDER,
      ...(typeof id === "string" ? { providerMessageId: id } : {}),
    };
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const call = await callProvider({
      url: `${base}/v1/account`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...tag(call.result), ok: false };
    const outcome = classifyResponse(
      call.response.status,
      call.response.headers,
      lettermillMeta.statusMap,
      { now: ctx.now },
    );
    await discardBody(call.response);
    if (outcome.status === "sent") return { ok: true };
    return { ...tag(outcome), ok: false };
  }

  return defineProvider({ meta: lettermillMeta, send, verify, webhooks });
}
