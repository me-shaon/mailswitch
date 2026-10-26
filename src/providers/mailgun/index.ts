// mailswitch/mailgun: the Mailgun adapter. It sends one message with
// `POST /v3/<domain>/messages` as multipart form data, and checks the key with
// `GET /v3/domains/<domain>`. The key goes in a Basic auth header, never in the URL.
// Mailgun has no idempotency key, so the mailer store gives the only duplicate protection.
// https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages
// https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { classifyResponse } from "../../core/classify";
import { validateMessage } from "../../core/message";
import type {
  AddressInput,
  NotSentResult,
  OutgoingMessage,
  SendResult,
  UnknownResult,
} from "../../core/types";
import { formatAddress, parseAddress } from "../../internal/address";
import { base64ToBytes, bytesToBase64, bytesToHex, utf8 } from "../../internal/encoding";
import { callProvider, discardBody, readJson } from "../../internal/http";
import { mailgunMeta } from "./meta";
import { bareMessageId, MAILGUN_MIN_DEDUPE_TTL_MS, mailgunWebhooks } from "./webhooks";

export { mailgunMeta } from "./meta";
export {
  MAILGUN_MIN_DEDUPE_TTL_MS,
  MAILGUN_WEBHOOK_MAX_AGE_MS,
  MAILGUN_WEBHOOK_MAX_SKEW_MS,
  mailgunSignature,
  parseMailgunEvents,
  verifyMailgunWebhook,
} from "./webhooks";

/** The API origin of each Mailgun region. */
export const MAILGUN_REGIONS: Readonly<{ us: string; eu: string }> = Object.freeze({
  us: "https://api.mailgun.net",
  eu: "https://api.eu.mailgun.net",
});

/** A Mailgun region. */
export type MailgunRegion = "us" | "eu";

/**
 * Mailgun webhooks have no signature over the body. The webhook router requires a dedupe
 * store in its types for every adapter that carries this marker.
 */
export const requiresDedupe: true = true;

/** Options of `mailgun`. */
export interface MailgunOptions {
  /** The API key. The `apiKey` credential takes precedence. */
  apiKey?: string;
  /** The sending domain, for example `mg.example.com`. The `domain` credential takes precedence. */
  domain?: string;
  /** The region of the domain. The `region` credential takes precedence. Defaults to `us`. */
  region?: MailgunRegion;
  /** The API origin, for tests or a proxy. It replaces the region origin. */
  baseUrl?: string;
}

/**
 * The Mailgun adapter. Its webhooks need a dedupe store, and the router binds each token
 * to the SHA-256 of the body. The dedupe TTL must be at least `minDedupeTtlMs`.
 */
export interface MailgunAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
  readonly bodyBoundKeys: true;
  readonly minDedupeTtlMs: number;
}

const PROVIDER = mailgunMeta.id;
// Words of the Mailgun sending-limit errors, as opposed to a request rate limit.
const QUOTA_TEXT = /\b(sending|message|daily|monthly|hourly|account|plan)\s+limit|\bquota\b/i;

function tag<T extends NotSentResult | UnknownResult>(result: T): T {
  return { ...result, provider: PROVIDER };
}

function address(input: AddressInput): string {
  const parsed = parseAddress(input);
  return parsed ? formatAddress(parsed) : "";
}

/**
 * Escapes a quoted parameter of a Content-Disposition header, as the HTML form encoding
 * does: `"` becomes `%22`, CR becomes `%0D`, and LF becomes `%0A`.
 */
export function escapeDispositionValue(value: string): string {
  return value.replace(/["\r\n]/g, (char) =>
    char === '"' ? "%22" : char === "\r" ? "%0D" : "%0A",
  );
}

/** One part of the form: a text field, or a file with a name and a type. */
export type MailgunFormPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; bytes: Uint8Array };

/** The form fields of one message, in order. Attachments are file parts. */
export function mailgunFormParts(message: OutgoingMessage): MailgunFormPart[] {
  const parts: MailgunFormPart[] = [{ name: "from", value: address(message.from) }];
  for (const to of message.to) parts.push({ name: "to", value: address(to) });
  for (const cc of message.cc ?? []) parts.push({ name: "cc", value: address(cc) });
  for (const bcc of message.bcc ?? []) parts.push({ name: "bcc", value: address(bcc) });
  parts.push({ name: "subject", value: message.subject });
  if (message.html !== undefined) parts.push({ name: "html", value: message.html });
  if (message.text !== undefined) parts.push({ name: "text", value: message.text });
  if (message.replyTo !== undefined) {
    parts.push({ name: "h:Reply-To", value: address(message.replyTo) });
  }
  // Custom headers go as `h:` fields, unchanged.
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    parts.push({ name: `h:${name}`, value });
  }
  for (const item of message.attachments ?? []) {
    const bytes =
      typeof item.content === "string"
        ? (base64ToBytes(item.content) ?? new Uint8Array(0))
        : item.content;
    // Mailgun names an inline file by its filename, and the HTML refers to `cid:<filename>`.
    parts.push(
      item.contentId === undefined
        ? { name: "attachment", filename: item.filename, contentType: item.contentType, bytes }
        : { name: "inline", filename: item.contentId, contentType: item.contentType, bytes },
    );
  }
  return parts;
}

/** Encodes form parts as a `multipart/form-data` body with the given boundary. */
export function encodeMultipart(parts: readonly MailgunFormPart[], boundary: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeDispositionValue(part.name)}"`;
    if ("filename" in part) {
      head += `; filename="${escapeDispositionValue(part.filename)}"\r\nContent-Type: ${part.contentType}`;
    }
    chunks.push(utf8(`${head}\r\n\r\n`));
    chunks.push("filename" in part ? part.bytes : utf8(part.value));
    chunks.push(utf8("\r\n"));
  }
  chunks.push(utf8(`--${boundary}--\r\n`));
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function newBoundary(): string {
  return `mailswitch-${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** The wait before a retry: `Retry-After`, otherwise `X-RateLimit-Reset`. */
function retryAfter(result: NotSentResult, headers: Headers, now: number): NotSentResult {
  if (result.retryAfterMs !== undefined || result.reason !== "rate_limited") return result;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) return result;
  // A value in seconds is far in the past as milliseconds. Read it as seconds.
  const at = reset < 1e12 ? reset * 1000 : reset;
  return { ...result, retryAfterMs: Math.max(0, at - now) };
}

async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Classifies a failed response. The body is read only to find a sending-limit error. It
 * is never copied into the result.
 */
async function failure(response: Response, now: number): Promise<NotSentResult | UnknownResult> {
  const outcome = classifyResponse(response.status, response.headers, mailgunMeta.statusMap, {
    now,
  }) as NotSentResult | UnknownResult;
  if (outcome.status === "unknown") {
    await discardBody(response);
    return tag(outcome);
  }
  const result = retryAfter(outcome, response.headers, now);
  if (response.status !== 403 && response.status !== 429) {
    await discardBody(response);
    return tag(result);
  }
  const text = await bodyText(response);
  if (!QUOTA_TEXT.test(text) || /\brate limit/i.test(text)) return tag(result);
  return tag({
    ...result,
    reason: "quota",
    message: `The provider answered with HTTP ${response.status} (quota).`,
  });
}

function checkOptions(options: MailgunOptions): string | undefined {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("mailgun expects an options object.");
  }
  if (options.region !== undefined && options.region !== "us" && options.region !== "eu") {
    throw new TypeError('mailgun: region must be "us" or "eu".');
  }
  if (options.baseUrl === undefined) return undefined;
  if (typeof options.baseUrl !== "string" || !/^https?:\/\/[^/]/i.test(options.baseUrl)) {
    throw new TypeError("mailgun: baseUrl must be an http or https URL.");
  }
  return options.baseUrl.replace(/\/+$/, "");
}

/** Creates the Mailgun adapter. Throws a TypeError for invalid options. */
export function mailgun(options: MailgunOptions = {}): MailgunAdapter {
  const baseUrl = checkOptions(options);

  function base(ctx: SendContext): string {
    if (baseUrl !== undefined) return baseUrl;
    const region = (ctx.credentials.region || options.region || "us").toLowerCase();
    return region === "eu" ? MAILGUN_REGIONS.eu : MAILGUN_REGIONS.us;
  }

  function domain(ctx: SendContext): string {
    return (ctx.credentials.domain || options.domain || "").trim().toLowerCase();
  }

  function authorization(ctx: SendContext): string {
    const key = ctx.credentials.apiKey || options.apiKey || "";
    return `Basic ${bytesToBase64(utf8(`api:${key}`))}`;
  }

  function noDomain(): NotSentResult {
    return tag({ status: "not_sent", reason: "auth", message: "The Mailgun domain is missing." });
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, mailgunMeta.capabilities);
    if (!checked.ok) return tag(checked.result);
    const name = domain(ctx);
    if (name === "") return noDomain();
    const boundary = newBoundary();
    const call = await callProvider({
      url: `${base(ctx)}/v3/${encodeURIComponent(name)}/messages`,
      headers: {
        authorization: authorization(ctx),
        accept: "application/json",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: encodeMultipart(mailgunFormParts(message), boundary) as Uint8Array<ArrayBuffer>,
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return tag(call.result);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now);
    const id = bareMessageId(((await readJson(response)) as { id?: unknown } | null)?.id);
    return { status: "sent", provider: PROVIDER, ...(id ? { providerMessageId: id } : {}) };
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const name = domain(ctx);
    if (name === "") return { ...noDomain(), ok: false };
    // Reading the domain is authenticated and sends no email.
    const call = await callProvider({
      url: `${base(ctx)}/v3/domains/${encodeURIComponent(name)}`,
      method: "GET",
      headers: { authorization: authorization(ctx), accept: "application/json" },
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...tag(call.result), ok: false };
    if (!call.response.ok) return { ...(await failure(call.response, ctx.now)), ok: false };
    await discardBody(call.response);
    return { ok: true };
  }

  const adapter = defineProvider({
    meta: mailgunMeta,
    send,
    verify,
    webhooks: mailgunWebhooks(PROVIDER),
  });
  return {
    ...adapter,
    webhooks: adapter.webhooks as ProviderWebhooks,
    requiresDedupe,
    bodyBoundKeys: true,
    minDedupeTtlMs: MAILGUN_MIN_DEDUPE_TTL_MS,
  };
}
