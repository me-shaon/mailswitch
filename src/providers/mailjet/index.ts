// mailswitch/mailjet: the Mailjet adapter. It sends with `POST /v3.1/send`, one message
// or a batch of up to 50, and checks the keys with `GET /v3/REST/user`. Auth is HTTP
// Basic: the API key is the username and the secret key is the password. Mailjet has no
// idempotency key, so the mailer store gives the only duplicate protection. Checked
// 2026-10-27.
// https://dev.mailjet.com/openapi/openapi-mailjet/send-emails/postsendv31.md
// https://dev.mailjet.com/docs/email-api/send-api-v31/send-api-errors.md
//
// Mailjet answers each message on its own ("we will process each message separately"),
// so one response can hold success entries and error entries. The rules:
// - When the body has a `Messages` array, each entry decides the result of its message,
//   in order, at any HTTP status.
//   - `Status: success` is `sent`, with `To[0].MessageUUID` as the id.
//   - `Status: error` is `not_sent` only when every `Errors[]` entry has a 4xx
//     `StatusCode`. A 5xx or a missing `StatusCode` makes it `unknown`.
//   - A missing entry, or an entry with another status, is `unknown`.
// - With no `Messages` array, the HTTP status decides, with the status map. A 2xx with no
//   `Messages` array is `unknown`. A 401 has an HTML body. The adapter reads the body only
//   as JSON and never copies it.

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { classifyResponse } from "../../core/classify";
import { validateMessage } from "../../core/message";
import type { NotSentResult, OutgoingMessage, SendResult, UnknownResult } from "../../core/types";
import { bytesToBase64, utf8 } from "../../internal/encoding";
import {
  callProvider,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import { mailjetMeta } from "./meta";
import { mailjetMessage } from "./payload";
import { type MailjetWebhookOptions, mailjetWebhooks } from "./webhooks";

export { mailjetMeta } from "./meta";
export {
  checkMailjetWebhookSecret,
  generateMailjetWebhookSecret,
  MAILJET_WEBHOOK_USERNAME,
  type MailjetWebhookOptions,
  mailjetWebhookAuthorization,
  mailjetWebhooks,
  mailjetWebhookUrl,
  parseMailjetEvents,
} from "./webhooks";

/** The Mailjet API origin. */
export const MAILJET_API_BASE = "https://api.mailjet.com";
/** The largest request body that Mailjet accepts, in bytes, with every attachment. */
export const MAILJET_MAX_REQUEST_BYTES = 15_000_000;

/** Options of `mailjet`. */
export interface MailjetOptions {
  /** The API key. The `apiKey` credential in the send context takes precedence. */
  apiKey?: string;
  /** The secret key. The `secretKey` credential in the send context takes precedence. */
  secretKey?: string;
  /** The API origin. Defaults to `MAILJET_API_BASE`. Tests and proxies change it. */
  baseUrl?: string;
  /**
   * Sets `SandboxMode: true` on each request. Mailjet checks the request and delivers
   * no email. A sandbox result has no message id.
   */
  sandbox?: boolean;
  /** The Basic auth username of the webhook. Defaults to `MAILJET_WEBHOOK_USERNAME`. */
  webhookUsername?: string;
  /**
   * The webhook secret before a rotation. While it is set, both the current secret (the
   * `secret` of `handleWebhook`) and this one pass.
   */
  previousWebhookSecret?: string;
}

/** The Mailjet adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface MailjetAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = mailjetMeta.id;
const HEAD = utf8('{"Messages":[]}').length;
const SANDBOX = utf8(',"SandboxMode":true').length;
const ERROR_CODE = /^[a-z]{2,8}-\d{4}$/;

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

/** The result of an entry that is missing, unclear, or not final, or of a body with no entries. */
function unknownEntry(httpStatus: number): UnknownResult {
  return {
    status: "unknown",
    reason: "provider_error",
    message: "Mailjet gave no clear result for this email.",
    httpStatus,
    provider: PROVIDER,
  };
}

/**
 * Maps one `Messages[i]` entry. A `not_sent` entry takes its reason from the first
 * `StatusCode`, through the status map. The result never copies `ErrorMessage`.
 */
function entryResult(item: unknown, httpStatus: number, now: number): SendResult {
  const entry = record(item);
  if (entry?.Status === "success") {
    const id = record((entry.To as unknown[] | undefined)?.[0])?.MessageUUID;
    return {
      status: "sent",
      provider: PROVIDER,
      ...(typeof id === "string" && id !== "" ? { providerMessageId: id } : {}),
    };
  }
  if (entry?.Status !== "error") return unknownEntry(httpStatus);
  const errors = Array.isArray(entry.Errors) ? entry.Errors.map(record) : [];
  const codes = errors.map((error) => error?.StatusCode);
  const clientOnly =
    codes.length > 0 &&
    codes.every((code) => typeof code === "number" && code >= 400 && code < 500);
  if (!clientOnly) return unknownEntry(httpStatus);
  const outcome = classifyResponse(codes[0] as number, new Headers(), mailjetMeta.statusMap, {
    now,
  });
  if (outcome.status !== "not_sent") {
    return withProvider({ ...(outcome as UnknownResult), httpStatus }, PROVIDER);
  }
  const code = errors[0]?.ErrorCode;
  const label = typeof code === "string" && ERROR_CODE.test(code) ? ` ${code}` : "";
  return {
    status: "not_sent",
    reason: outcome.reason,
    message: `Mailjet refused this email with StatusCode ${String(codes[0])}${label} (${outcome.reason}).`,
    httpStatus,
    provider: PROVIDER,
  } satisfies NotSentResult;
}

function checkOptions(options: MailjetOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("mailjet expects an options object.");
  }
  for (const name of ["apiKey", "secretKey", "webhookUsername"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "string") {
      throw new TypeError(`mailjet: ${name} must be a string.`);
    }
  }
  if (options.sandbox !== undefined && typeof options.sandbox !== "boolean") {
    throw new TypeError("mailjet: sandbox must be a boolean.");
  }
  return parseBaseUrl(options.baseUrl, MAILJET_API_BASE, "mailjet: baseUrl");
}

/**
 * Creates the Mailjet adapter.
 *
 * @throws TypeError for invalid options, an invalid webhook username, or a
 * `previousWebhookSecret` with less than 128 bits.
 */
export function mailjet(options: MailjetOptions = {}): MailjetAdapter {
  const base = checkOptions(options);
  const hookOptions: MailjetWebhookOptions = {};
  if (options.webhookUsername !== undefined) hookOptions.username = options.webhookUsername;
  if (options.previousWebhookSecret !== undefined) {
    hookOptions.previousSecret = options.previousWebhookSecret;
  }
  const webhooks = mailjetWebhooks(PROVIDER, hookOptions);
  const sandbox = options.sandbox === true;
  const limit = MAILJET_MAX_REQUEST_BYTES - HEAD - (sandbox ? SANDBOX : 0);

  function headers(ctx: SendContext): Record<string, string> {
    const key = ctx.credentials.apiKey || options.apiKey || "";
    const secret = ctx.credentials.secretKey || options.secretKey || "";
    return {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${bytesToBase64(utf8(`${key}:${secret}`))}`,
    };
  }

  /** Sends one request of `parts` (encoded `Messages` entries). One result per part. */
  async function post(parts: readonly string[], ctx: SendContext): Promise<SendResult[]> {
    const body = `{"Messages":[${parts.join(",")}]${sandbox ? ',"SandboxMode":true' : ""}}`;
    const call = await callProvider({
      url: `${base}/v3.1/send`,
      headers: headers(ctx),
      body,
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return parts.map(() => withProvider(call.result, PROVIDER));
    const { response } = call;
    const json = record(await readJson(response));
    const items = json?.Messages;
    if (Array.isArray(items)) {
      return parts.map((_, index) => entryResult(items[index], response.status, ctx.now));
    }
    const outcome: SendResult = response.ok
      ? unknownEntry(response.status)
      : withProvider(
          classifyResponse(response.status, response.headers, mailjetMeta.statusMap, {
            now: ctx.now,
          }) as NotSentResult | UnknownResult,
          PROVIDER,
        );
    return parts.map(() => outcome);
  }

  /**
   * Validates and sends the messages. A message that fails a local check keeps its own
   * `not_sent` result. The rest go out in requests whose bodies stay under 15 MB.
   */
  async function deliver(
    messages: readonly OutgoingMessage[],
    ctx: SendContext,
  ): Promise<SendResult[]> {
    const results: (SendResult | undefined)[] = new Array(messages.length);
    const groups: { slots: number[]; parts: string[]; bytes: number }[] = [];
    let group: (typeof groups)[number] | undefined;
    messages.forEach((message, index) => {
      const checked = validateMessage(message, mailjetMeta.capabilities);
      if (!checked.ok) {
        results[index] = withProvider(checked.result, PROVIDER);
        return;
      }
      const part = JSON.stringify(mailjetMessage(message));
      const bytes = utf8(part).length;
      if (bytes > limit) {
        results[index] = withProvider(
          {
            status: "not_sent",
            reason: "unsupported",
            message: `The Mailjet request body of this email is ${bytes} bytes. The limit is ${MAILJET_MAX_REQUEST_BYTES} bytes.`,
          },
          PROVIDER,
        );
        return;
      }
      // One comma joins two entries.
      if (group === undefined || group.bytes + 1 + bytes > limit) {
        group = { slots: [], parts: [], bytes: -1 };
        groups.push(group);
      }
      group.slots.push(index);
      group.parts.push(part);
      group.bytes += 1 + bytes;
    });
    for (const item of groups) {
      const list = await post(item.parts, ctx);
      item.slots.forEach((slot, position) => {
        results[slot] = list[position];
      });
    }
    return results as SendResult[];
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    return (await deliver([message], ctx))[0] as SendResult;
  }

  async function sendBatch(
    messages: readonly OutgoingMessage[],
    ctx: SendContext,
  ): Promise<SendResult[]> {
    if (messages.length > mailjetMeta.capabilities.batchSize) {
      throw new RangeError(
        `Mailjet takes at most ${mailjetMeta.capabilities.batchSize} messages per batch.`,
      );
    }
    return deliver(messages, ctx);
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const call = await callProvider({
      url: `${base}/v3/REST/user`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...withProvider(call.result, PROVIDER), ok: false };
    const { response } = call;
    await discardBody(response);
    if (response.ok) return { ok: true };
    const outcome = classifyResponse(response.status, response.headers, mailjetMeta.statusMap, {
      now: ctx.now,
    }) as NotSentResult | UnknownResult;
    return { ...withProvider(outcome, PROVIDER), ok: false };
  }

  const adapter = defineProvider({ meta: mailjetMeta, send, sendBatch, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
