// mailswitch/cloudflare: Cloudflare Email Sending, with two transports.
//
// - `cloudflareRest` posts JSON to the REST API. It works on Workers Free and on any
//   runtime with fetch. https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
// - `cloudflareBinding` calls the `send_email` binding of a Worker. It needs no token.
//   https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
//
// Cloudflare sends delivery events to a Queue, not to a webhook, so neither transport has
// webhooks. This file imports no `cloudflare:*` module. The binding has a local type.

import {
  defineProvider,
  type ProviderAdapter,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { classifyResponse, classifyThrown } from "../../core/classify";
import { validateMessage } from "../../core/message";
import type {
  Address,
  AddressInput,
  FailureReason,
  NotSentResult,
  OutgoingMessage,
  SendResult,
  UnknownResult,
} from "../../core/types";
import { parseAddress } from "../../internal/address";
import { base64ToBytes, bytesToBase64 } from "../../internal/encoding";
import { callProvider, discardBody, readJson } from "../../internal/http";
import { cloudflareBindingMeta, cloudflareRestMeta } from "./meta";

export { cloudflareBindingMeta, cloudflareRestMeta } from "./meta";

/** The Cloudflare API origin, with the version path. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

const REST = cloudflareRestMeta.id;
const BINDING = cloudflareBindingMeta.id;
const CONCURRENCY = 5;

function tag<T extends NotSentResult | UnknownResult>(result: T, provider: string): T {
  return { ...result, provider };
}

function parsed(input: AddressInput): Address {
  // validateMessage has checked every address, so parseAddress cannot fail here.
  return parseAddress(input) ?? { email: "" };
}

// ---------------------------------------------------------------------------------------
// REST transport
// ---------------------------------------------------------------------------------------

/** Options of `cloudflareRest`. */
export interface CloudflareRestOptions {
  /** The account ID. `SendContext.credentials.accountId` takes precedence. */
  accountId?: string;
  /** The API token. `SendContext.credentials.apiToken` takes precedence. */
  apiToken?: string;
  /** The API origin with the version path. Tests and proxies change it. */
  baseUrl?: string;
}

interface RestBody {
  success?: unknown;
  errors?: { code?: unknown }[];
  result?: {
    message_id?: unknown;
    delivered?: unknown;
    queued?: unknown;
    permanent_bounces?: unknown;
    suppressed_recipients?: unknown;
  } | null;
}

/** A REST address: a bare email, or `{ address, name }` with a display name. */
function restAddress(input: AddressInput): string | { address: string; name: string } {
  const value = parsed(input);
  return value.name ? { address: value.email, name: value.name } : value.email;
}

/** The JSON body of one email, in the shape of the REST send API. */
function restPayload(message: OutgoingMessage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: restAddress(message.from),
    to: message.to.map(restAddress),
    subject: message.subject,
  };
  if (message.cc?.length) body.cc = message.cc.map(restAddress);
  if (message.bcc?.length) body.bcc = message.bcc.map(restAddress);
  // The docs show reply_to only as a plain string, so the display name is dropped.
  if (message.replyTo !== undefined) body.reply_to = parsed(message.replyTo).email;
  if (message.html !== undefined) body.html = message.html;
  if (message.text !== undefined) body.text = message.text;
  if (message.headers && Object.keys(message.headers).length > 0) body.headers = message.headers;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((item) => {
      const out: Record<string, string> = {
        content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
        filename: item.filename,
        type: item.contentType,
        disposition: item.contentId === undefined ? "attachment" : "inline",
      };
      // The docs do not show the inline id field. This follows the snake_case REST naming.
      if (item.contentId !== undefined) out.content_id = item.contentId;
      return out;
    });
  }
  return body;
}

/**
 * Refines the reason of a `not_sent` REST result with the documented error code. The
 * status never changes. https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 */
function refineRest(result: NotSentResult, body: RestBody | null): NotSentResult {
  const code = body?.errors?.[0]?.code;
  let reason: FailureReason = result.reason;
  // 10000 not_found: the account in the URL does not exist for this token.
  // 10105 not_entitled, 10203 sending_disabled, 10207 account_suspended: the account
  // cannot send. They are 403, which the default table already maps to auth.
  if (code === 10000) reason = "auth";
  else if (code === 10004) reason = "rate_limited";
  else if (code === 10001 || code === 10200 || code === 10201 || code === 10202) {
    reason = "invalid_message";
  }
  if (reason === result.reason) return result;
  return {
    ...result,
    reason,
    message: `The provider answered with HTTP ${result.httpStatus} (${reason}).`,
  };
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * A 2xx lists each recipient as delivered, queued, bounced, or suppressed. When no
 * recipient was delivered or queued, the message went to nobody, so it is not sent.
 */
function restAccepted(message: OutgoingMessage, body: RestBody | null): SendResult {
  if (body !== null && body.success === false) {
    return {
      status: "unknown",
      reason: "provider_error",
      message: "Cloudflare answered with a 2xx status and success false.",
      provider: REST,
    };
  }
  const result = body?.result ?? null;
  const dropped = new Set(
    [...asList(result?.permanent_bounces), ...asList(result?.suppressed_recipients)].map((item) =>
      item.toLowerCase(),
    ),
  );
  if (dropped.size > 0 && asList(result?.delivered).length + asList(result?.queued).length === 0) {
    const all = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
    if (all.every((item) => dropped.has(parsed(item).email.toLowerCase()))) {
      return {
        status: "not_sent",
        reason: "rejected",
        message: "Cloudflare dropped every recipient as bounced or suppressed.",
        provider: REST,
      };
    }
  }
  const id = result?.message_id;
  return {
    status: "sent",
    provider: REST,
    ...(typeof id === "string" && id !== "" ? { providerMessageId: id } : {}),
  };
}

function checkRestOptions(options: CloudflareRestOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("cloudflareRest expects an options object.");
  }
  for (const key of ["accountId", "apiToken"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "string") {
      throw new TypeError(`cloudflareRest: ${key} must be a string.`);
    }
  }
  const base = options.baseUrl ?? CLOUDFLARE_API_BASE;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TypeError("cloudflareRest: baseUrl must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("cloudflareRest: baseUrl must be an http or https URL.");
  }
  return base.replace(/\/+$/, "");
}

/** Creates the REST transport adapter. Throws a TypeError for invalid options. */
export function cloudflareRest(options: CloudflareRestOptions = {}): ProviderAdapter {
  const base = checkRestOptions(options);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      authorization: `Bearer ${ctx.credentials.apiToken || options.apiToken || ""}`,
      "content-type": "application/json",
    };
  }

  function account(ctx: SendContext): string {
    return encodeURIComponent(ctx.credentials.accountId || options.accountId || "");
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, cloudflareRestMeta.capabilities);
    if (!checked.ok) return tag(checked.result, REST);
    const call = await callProvider({
      url: `${base}/accounts/${account(ctx)}/email/sending/send`,
      headers: headers(ctx),
      body: JSON.stringify(restPayload(message)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return tag(call.result, REST);
    const response = call.response;
    const outcome = classifyResponse(
      response.status,
      response.headers,
      cloudflareRestMeta.statusMap,
      {
        now: ctx.now,
      },
    );
    if (outcome.status === "unknown") {
      await discardBody(response);
      return tag(outcome, REST);
    }
    const body = (await readJson(response)) as RestBody | null;
    if (outcome.status === "not_sent") return tag(refineRest(outcome, body), REST);
    return restAccepted(message, body);
  }

  /**
   * Sends each message with its own request, 5 at a time. After a failure for the whole
   * account (auth, rate_limited, or quota), the messages that have not started get the same
   * `not_sent` result with no request.
   */
  async function sendBatch(
    messages: readonly OutgoingMessage[],
    ctx: SendContext,
  ): Promise<SendResult[]> {
    const results: SendResult[] = new Array(messages.length);
    let stop: NotSentResult | undefined;
    let next = 0;
    async function worker(): Promise<void> {
      while (next < messages.length) {
        const index = next++;
        if (stop) {
          results[index] = { ...stop };
          continue;
        }
        const result = await send(messages[index] as OutgoingMessage, ctx);
        results[index] = result;
        if (
          !stop &&
          result.status === "not_sent" &&
          (result.reason === "auth" ||
            result.reason === "rate_limited" ||
            result.reason === "quota")
        ) {
          stop = result;
        }
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, messages.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  /**
   * Checks the API token with the token verify call, which sends no email. An account
   * token verifies under the account. A user token verifies under the user.
   */
  async function verify(ctx: SendContext): Promise<VerifyResult> {
    let last = 401;
    for (const path of [`/accounts/${account(ctx)}/tokens/verify`, "/user/tokens/verify"]) {
      const call = await callProvider({
        url: `${base}${path}`,
        method: "GET",
        headers: headers(ctx),
        timeoutMs: ctx.timeoutMs,
        fetch: ctx.fetch,
      });
      if (!call.ok) return { ...tag(call.result, REST), ok: false };
      const response = call.response;
      last = response.status;
      const outcome = classifyResponse(
        response.status,
        response.headers,
        cloudflareRestMeta.statusMap,
        {
          now: ctx.now,
        },
      );
      if (outcome.status === "unknown") {
        await discardBody(response);
        return { ...tag(outcome, REST), ok: false };
      }
      if (outcome.status === "sent") {
        const body = (await readJson(response)) as { result?: { status?: unknown } } | null;
        const status = body?.result?.status;
        if (status === undefined || status === "active") return { ok: true };
        return {
          status: "not_sent",
          reason: "auth",
          message: "The API token is not active.",
          httpStatus: response.status,
          provider: REST,
          ok: false,
        };
      }
      await discardBody(response);
    }
    return {
      status: "not_sent",
      reason: "auth",
      message: "Cloudflare refused the API token. Check the token and the account ID.",
      httpStatus: last,
      provider: REST,
      ok: false,
    };
  }

  return defineProvider({ meta: cloudflareRestMeta, send, sendBatch, verify });
}

// ---------------------------------------------------------------------------------------
// Workers binding transport
// ---------------------------------------------------------------------------------------

/** A mailbox with a display name, in the binding shape. */
export interface CloudflareEmailAddress {
  email: string;
  name: string;
}

/** One attachment, in the binding shape. An inline attachment needs a content id. */
export type CloudflareEmailAttachment =
  | {
      disposition: "inline";
      contentId: string;
      filename: string;
      type: string;
      content: string | ArrayBuffer | ArrayBufferView;
    }
  | {
      disposition: "attachment";
      contentId?: undefined;
      filename: string;
      type: string;
      content: string | ArrayBuffer | ArrayBufferView;
    };

/** The structured message that `send_email` accepts, so no raw MIME is needed. */
export interface CloudflareEmailBuilder {
  from: string | CloudflareEmailAddress;
  to: (string | CloudflareEmailAddress)[];
  cc?: (string | CloudflareEmailAddress)[];
  bcc?: (string | CloudflareEmailAddress)[];
  replyTo?: string | CloudflareEmailAddress;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: CloudflareEmailAttachment[];
}

/**
 * The part of the Workers `send_email` binding (`SendEmail` in
 * `@cloudflare/workers-types`) that mailswitch uses. A local type, so mailswitch needs no
 * Workers types and imports no `cloudflare:*` module.
 */
export interface CloudflareSendEmail {
  send(message: CloudflareEmailBuilder): Promise<{ messageId?: string } | undefined>;
}

/** Where `cloudflareBinding` finds the binding. */
export type CloudflareBindingSource =
  | CloudflareSendEmail
  /** The Worker `env`. The adapter reads the binding named by `credentials.bindingName`. */
  | { env: Readonly<Record<string, unknown>> };

/**
 * The binding error codes that prove that Cloudflare did not accept the message, with the
 * reason of each. Every other code, and an error with no code, is `unknown`. This includes
 * `E_DELIVERY_FAILED` and `E_INTERNAL_SERVER_ERROR`.
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export const CLOUDFLARE_BINDING_NOT_SENT: Readonly<Record<string, FailureReason>> = Object.freeze({
  E_VALIDATION_ERROR: "invalid_message",
  E_FIELD_MISSING: "invalid_message",
  E_TOO_MANY_RECIPIENTS: "invalid_message",
  E_TOO_MANY_ATTACHMENTS: "invalid_message",
  E_CONTENT_TOO_LARGE: "invalid_message",
  E_HEADER_NOT_ALLOWED: "invalid_message",
  E_HEADER_USE_API_FIELD: "invalid_message",
  E_HEADER_VALUE_INVALID: "invalid_message",
  E_HEADER_VALUE_TOO_LONG: "invalid_message",
  E_HEADER_NAME_INVALID: "invalid_message",
  E_HEADERS_TOO_LARGE: "invalid_message",
  E_HEADERS_TOO_MANY: "invalid_message",
  E_SENDER_NOT_VERIFIED: "rejected",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "rejected",
  E_RECIPIENT_NOT_ALLOWED: "rejected",
  E_RECIPIENT_SUPPRESSED: "rejected",
  E_ACCOUNT_SUSPENDED: "auth",
  E_RATE_LIMIT_EXCEEDED: "rate_limited",
  E_DAILY_LIMIT_EXCEEDED: "quota",
});

const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isBinding(value: unknown): value is CloudflareSendEmail {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { send?: unknown }).send === "function"
  );
}

function bindingAddress(input: AddressInput): string | CloudflareEmailAddress {
  const value = parsed(input);
  return value.name ? { email: value.email, name: value.name } : value.email;
}

/** The structured message of one email, in the shape of the binding. */
export function cloudflareBindingMessage(message: OutgoingMessage): CloudflareEmailBuilder {
  const out: CloudflareEmailBuilder = {
    from: bindingAddress(message.from),
    to: message.to.map(bindingAddress),
    subject: message.subject,
  };
  if (message.cc?.length) out.cc = message.cc.map(bindingAddress);
  if (message.bcc?.length) out.bcc = message.bcc.map(bindingAddress);
  if (message.replyTo !== undefined) out.replyTo = bindingAddress(message.replyTo);
  if (message.html !== undefined) out.html = message.html;
  if (message.text !== undefined) out.text = message.text;
  if (message.headers && Object.keys(message.headers).length > 0) {
    out.headers = { ...message.headers };
  }
  if (message.attachments?.length) {
    out.attachments = message.attachments.map((item) => {
      // A string is base64. The binding reads a string as text, so it gets the bytes.
      const content =
        typeof item.content === "string"
          ? (base64ToBytes(item.content) ?? new Uint8Array(0))
          : item.content;
      return item.contentId === undefined
        ? { disposition: "attachment", filename: item.filename, type: item.contentType, content }
        : {
            disposition: "inline",
            contentId: item.contentId,
            filename: item.filename,
            type: item.contentType,
            content,
          };
    });
  }
  return out;
}

/** Classifies an error that the binding threw. */
export function classifyBindingError(error: unknown): NotSentResult | UnknownResult {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const reason = typeof code === "string" ? CLOUDFLARE_BINDING_NOT_SENT[code] : undefined;
  if (reason !== undefined) {
    return {
      status: "not_sent",
      reason,
      message: `Cloudflare refused the message (${code as string}).`,
      provider: BINDING,
    };
  }
  if (typeof code === "string" && /^E_[A-Z_]{1,64}$/.test(code)) {
    return {
      status: "unknown",
      reason: "provider_error",
      message: `The send_email binding failed (${code}). The message may have gone out.`,
      provider: BINDING,
    };
  }
  return { ...classifyThrown(error), provider: BINDING };
}

class BindingTimeout extends Error {
  override name = "TimeoutError";
}

/** Runs `task` with a timeout. The task keeps running after the timeout. */
async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BindingTimeout("The binding did not answer.")), timeoutMs);
  });
  try {
    return await Promise.race([task, limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Creates the Workers binding transport adapter. Pass the binding, for example
 * `cloudflareBinding(env.EMAIL)`, or `{ env }` to find the binding by the `bindingName`
 * credential. Throws a TypeError for an invalid source.
 */
export function cloudflareBinding(source: CloudflareBindingSource): ProviderAdapter {
  if (typeof source !== "object" || source === null) {
    throw new TypeError("cloudflareBinding expects a send_email binding or { env }.");
  }
  const direct = isBinding(source) ? source : undefined;
  const env = direct ? undefined : (source as { env?: unknown }).env;
  if (!direct && (typeof env !== "object" || env === null)) {
    throw new TypeError("cloudflareBinding expects a send_email binding or { env }.");
  }

  function resolve(ctx: SendContext): CloudflareSendEmail | undefined {
    if (direct) return direct;
    const name = ctx.credentials.bindingName || "EMAIL";
    if (!BINDING_NAME.test(name)) return undefined;
    const value = (env as Record<string, unknown>)[name];
    return isBinding(value) ? value : undefined;
  }

  function missing(): NotSentResult {
    return {
      status: "not_sent",
      reason: "auth",
      message:
        "The send_email binding is missing. Check the binding name and the Wrangler configuration.",
      provider: BINDING,
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, cloudflareBindingMeta.capabilities);
    if (!checked.ok) return tag(checked.result, BINDING);
    const binding = resolve(ctx);
    if (!binding) return missing();
    const payload = cloudflareBindingMessage(message);
    let answer: { messageId?: unknown } | undefined;
    try {
      answer = await withTimeout(
        Promise.resolve().then(() => binding.send(payload)),
        ctx.timeoutMs,
      );
    } catch (error) {
      return classifyBindingError(error);
    }
    const id = typeof answer === "object" && answer !== null ? answer.messageId : undefined;
    return {
      status: "sent",
      provider: BINDING,
      ...(typeof id === "string" && id !== "" ? { providerMessageId: id } : {}),
    };
  }

  /**
   * The binding has no read call, so `verify` checks only that the binding is present.
   * It sends no email.
   */
  async function verify(ctx: SendContext): Promise<VerifyResult> {
    return resolve(ctx) ? { ok: true } : { ...missing(), ok: false };
  }

  return defineProvider({ meta: cloudflareBindingMeta, send, verify });
}
