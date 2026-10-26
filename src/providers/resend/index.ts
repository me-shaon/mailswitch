// mailswitch/resend: the Resend adapter. Single sends go to POST /emails, which accepts
// attachments. `sendBatch` uses POST /emails/batch for messages without attachments.
// https://resend.com/docs/api-reference/emails/send-email
// https://resend.com/docs/api-reference/emails/send-batch-emails
// https://resend.com/docs/api-reference/errors

import {
  defineProvider,
  type ProviderAdapter,
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
import { bytesToBase64, bytesToHex, utf8 } from "../../internal/encoding";
import { callProvider, discardBody, readJson } from "../../internal/http";
import { resendMeta } from "./meta";
import { parseResendEvents, verifyResendWebhook } from "./webhooks";

export { resendMeta } from "./meta";
export {
  parseResendEvents,
  SVIX_TOLERANCE_MS,
  type SvixVerifier,
  svixSignedPayload,
  svixVerifier,
  verifyResendWebhook,
} from "./webhooks";

/** The Resend API origin. */
export const RESEND_API_BASE = "https://api.resend.com";
/** The longest `Idempotency-Key` that Resend accepts. A longer key goes out as its SHA-256 hex. */
export const RESEND_MAX_KEY_LENGTH = 256;

/** Options of `resend`. */
export interface ResendOptions {
  /**
   * The API key. The key in `SendContext.credentials` takes precedence, so a mailer that
   * parses credentials can omit it here.
   */
  apiKey?: string;
  /** The API origin. Defaults to `https://api.resend.com`. Tests and proxies change it. */
  baseUrl?: string;
}

interface ResendError {
  name?: unknown;
  message?: unknown;
}

const PROVIDER = resendMeta.id;
// Printable ASCII only. Any other key goes out hashed, because a header carries bytes.
const PLAIN_KEY = /^[\x20-\x7e]+$/;
const INVALID_KEY_TEXT = /\bapi key is invalid\b/i;

/**
 * The `Idempotency-Key` value for a message key. A printable ASCII key of at most 256
 * characters goes out as it is. Any other key goes out as the SHA-256 hex of its UTF-8
 * bytes, so two long keys with a shared prefix never collide.
 */
export async function resendIdempotencyKey(key: string): Promise<string> {
  if (key.length <= RESEND_MAX_KEY_LENGTH && PLAIN_KEY.test(key)) return key;
  return bytesToHex(await crypto.subtle.digest("SHA-256", utf8(key)));
}

function address(input: AddressInput): string {
  const parsed = parseAddress(input);
  return parsed ? formatAddress(parsed) : "";
}

/** The JSON object of one email, in the shape of the Resend send API. */
function emailPayload(message: OutgoingMessage): Record<string, unknown> {
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
    body.attachments = message.attachments.map((item) => {
      const out: Record<string, string> = {
        filename: item.filename,
        content: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
        content_type: item.contentType,
      };
      if (item.contentId !== undefined) out.content_id = item.contentId;
      return out;
    });
  }
  return body;
}

function tag<T extends NotSentResult | UnknownResult>(result: T): T {
  return { ...result, provider: PROVIDER };
}

/**
 * Refines the reason of a `not_sent` result with the Resend error name. The status never
 * changes. The message keeps the fixed text and never copies the response body.
 */
function refine(result: NotSentResult, error: ResendError | null): NotSentResult {
  const name = typeof error?.name === "string" ? error.name : "";
  const text = typeof error?.message === "string" ? error.message : "";
  let reason = result.reason;
  if (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") reason = "quota";
  else if (name === "rate_limit_exceeded") reason = "rate_limited";
  else if (/_api_key$/.test(name)) reason = "auth";
  // Resend can answer a wrong key with 400 validation_error and this text.
  else if (name === "validation_error" && INVALID_KEY_TEXT.test(text)) reason = "auth";
  if (reason === result.reason) return result;
  return {
    ...result,
    reason,
    message: `The provider answered with HTTP ${result.httpStatus} (${reason}).`,
  };
}

/** Classifies a failed response. Reads the body only to refine a `not_sent` reason. */
async function failure(
  response: Response,
  ctx: SendContext,
): Promise<NotSentResult | UnknownResult | null> {
  const outcome = classifyResponse(response.status, response.headers, resendMeta.statusMap, {
    now: ctx.now,
  });
  if (outcome.status === "sent") return null;
  if (outcome.status === "unknown") {
    await discardBody(response);
    return tag(outcome);
  }
  return tag(refine(outcome, (await readJson(response)) as ResendError | null));
}

function checkOptions(options: ResendOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("resend expects an options object.");
  }
  if (options.apiKey !== undefined && typeof options.apiKey !== "string") {
    throw new TypeError("resend: apiKey must be a string.");
  }
  const base = options.baseUrl ?? RESEND_API_BASE;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TypeError("resend: baseUrl must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("resend: baseUrl must be an http or https URL.");
  }
  return base.replace(/\/+$/, "");
}

/** Creates the Resend adapter. Throws a TypeError for invalid options. */
export function resend(options: ResendOptions = {}): ProviderAdapter {
  const base = checkOptions(options);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      authorization: `Bearer ${ctx.credentials.apiKey || options.apiKey || ""}`,
      "content-type": "application/json",
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, resendMeta.capabilities);
    if (!checked.ok) return tag(checked.result);
    const head = headers(ctx);
    if (message.idempotencyKey !== undefined) {
      head["idempotency-key"] = await resendIdempotencyKey(message.idempotencyKey);
    }
    const call = await callProvider({
      url: `${base}/emails`,
      headers: head,
      body: JSON.stringify(emailPayload(message)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return tag(call.result);
    const failed = await failure(call.response, ctx);
    if (failed) return failed;
    const id = ((await readJson(call.response)) as { id?: unknown } | null)?.id;
    return {
      status: "sent",
      provider: PROVIDER,
      ...(typeof id === "string" ? { providerMessageId: id } : {}),
    };
  }

  /** One POST /emails/batch. It carries no Idempotency-Key: the key would cover the request. */
  async function batchCall(
    messages: readonly OutgoingMessage[],
    ctx: SendContext,
  ): Promise<SendResult[]> {
    const call = await callProvider({
      url: `${base}/emails/batch`,
      headers: headers(ctx),
      body: JSON.stringify(messages.map(emailPayload)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    const failed = call.ok ? await failure(call.response, ctx) : tag(call.result);
    if (failed) return messages.map(() => ({ ...failed }));
    // Strict validation: a 2xx means Resend accepted every email. `data` lists the ids in order.
    const json = (await readJson((call as { response: Response }).response)) as {
      data?: { id?: unknown }[];
    } | null;
    const data = Array.isArray(json?.data) ? json.data : [];
    return messages.map((_, index) => {
      const id = data[index]?.id;
      return {
        status: "sent",
        provider: PROVIDER,
        ...(typeof id === "string" ? { providerMessageId: id } : {}),
      };
    });
  }

  async function sendBatch(
    messages: readonly OutgoingMessage[],
    ctx: SendContext,
  ): Promise<SendResult[]> {
    const results: SendResult[] = new Array(messages.length);
    const pending: Promise<void>[] = [];
    let group: { index: number; message: OutgoingMessage }[] = [];
    const flush = () => {
      const items = group;
      group = [];
      if (items.length === 0) return;
      pending.push(
        batchCall(
          items.map((item) => item.message),
          ctx,
        ).then((list) => {
          items.forEach((item, i) => {
            results[item.index] = list[i] as SendResult;
          });
        }),
      );
    };
    messages.forEach((message, index) => {
      const checked = validateMessage(message, resendMeta.capabilities);
      if (!checked.ok) {
        results[index] = tag(checked.result);
      } else if (message.attachments?.length) {
        // The batch endpoint refuses attachments, so this message goes through send.
        pending.push(
          send(message, ctx).then((result) => {
            results[index] = result;
          }),
        );
      } else {
        group.push({ index, message });
        if (group.length >= resendMeta.capabilities.batchSize) flush();
      }
    });
    flush();
    await Promise.all(pending);
    return results;
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    // Listing domains is authenticated and sends no email.
    const call = await callProvider({
      url: `${base}/domains`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...tag(call.result), ok: false };
    const response = call.response;
    if (response.status === 401) {
      // A sending-only key cannot list domains, but it can send.
      const error = (await readJson(response)) as ResendError | null;
      if (error?.name === "restricted_api_key") return { ok: true };
      const outcome = classifyResponse(401, response.headers, resendMeta.statusMap);
      return { ...tag(outcome as NotSentResult), ok: false };
    }
    const failed = await failure(response, ctx);
    if (failed) return { ...failed, ok: false };
    await discardBody(response);
    return { ok: true };
  }

  return defineProvider({
    meta: resendMeta,
    send,
    sendBatch,
    verify,
    webhooks: { verify: verifyResendWebhook, parse: parseResendEvents },
  });
}
