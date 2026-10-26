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
import { classifyResponse } from "../../core/classify";
import { validateMessage } from "../../core/message";
import type {
  Address,
  AddressInput,
  FailureReason,
  NotSentResult,
  OutgoingMessage,
  SendResult,
} from "../../core/types";
import { parseAddress } from "../../internal/address";
import { bytesToBase64 } from "../../internal/encoding";
import {
  callProvider,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import {
  type CloudflareSendEmail,
  classifyBindingError,
  cloudflareBindingMessage,
} from "./binding";
import { cloudflareBindingMeta, cloudflareRestMeta } from "./meta";

export type {
  CloudflareEmailAddress,
  CloudflareEmailAttachment,
  CloudflareEmailBuilder,
  CloudflareSendEmail,
} from "./binding";
export { cloudflareBindingMeta, cloudflareRestMeta } from "./meta";

/** The Cloudflare API origin, with the version path. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

const REST = cloudflareRestMeta.id;
const BINDING = cloudflareBindingMeta.id;
const CONCURRENCY = 5;

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
  return parseBaseUrl(options.baseUrl, CLOUDFLARE_API_BASE, "cloudflareRest: baseUrl");
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
    if (!checked.ok) return withProvider(checked.result, REST);
    const call = await callProvider({
      url: `${base}/accounts/${account(ctx)}/email/sending/send`,
      headers: headers(ctx),
      body: JSON.stringify(restPayload(message)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, REST);
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
      return withProvider(outcome, REST);
    }
    const body = (await readJson(response)) as RestBody | null;
    if (outcome.status === "not_sent") return withProvider(refineRest(outcome, body), REST);
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
      if (!call.ok) return { ...withProvider(call.result, REST), ok: false };
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
        return { ...withProvider(outcome, REST), ok: false };
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

/** Where `cloudflareBinding` finds the binding. */
export type CloudflareBindingSource =
  | CloudflareSendEmail
  /** The Worker `env`. The adapter reads the binding named by `credentials.bindingName`. */
  | { env: Readonly<Record<string, unknown>> };

const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isBinding(value: unknown): value is CloudflareSendEmail {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { send?: unknown }).send === "function"
  );
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
    if (!checked.ok) return withProvider(checked.result, BINDING);
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
