// mailswitch/mailchannels: the MailChannels Email API adapter. It sends one message with
// `POST /tx/v1/send` and checks the key with `GET /tx/v1/usage`. MailChannels has no
// idempotency key, so the mailer store gives the only duplicate protection. Checked
// 2026-10-27.
// https://docs.mailchannels.com/api-reference/send/send-an-email
// https://docs.mailchannels.com/email-api/errors
// https://docs.mailchannels.com/api-reference/usage/retrieve-usage-stats

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { validateMessage } from "../../core/message";
import type { OutgoingMessage, SendResult, UnknownResult } from "../../core/types";
import {
  callProvider,
  classifyFailure,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import { asRecord, stringField } from "../../internal/json";
import { verifyByGet } from "../../internal/verify";
import { mailchannelsMeta } from "./meta";
import { headerProblem, mailchannelsPayload } from "./payload";
import { mailchannelsWebhooks } from "./webhooks";

export { mailchannelsMeta } from "./meta";
export { MAILCHANNELS_MAX_HEADER_BYTES } from "./payload";
export {
  MAILCHANNELS_DIGEST_HEADER,
  MAILCHANNELS_MAX_WEBHOOK_EVENTS,
  MAILCHANNELS_SIGNATURE_HEADER,
  MAILCHANNELS_SIGNATURE_INPUT_HEADER,
  MAILCHANNELS_WEBHOOK_FUTURE_SKEW_MS,
  MAILCHANNELS_WEBHOOK_TOLERANCE_MS,
  mailchannelsContentDigest,
  mailchannelsSignatureBase,
  mailchannelsWebhooks,
  parseMailchannelsEvents,
  verifyMailchannelsWebhook,
} from "./webhooks";

/** The MailChannels Email API origin. */
export const MAILCHANNELS_API_BASE = "https://api.mailchannels.net";

/** Options of `mailchannels`. */
export interface MailchannelsOptions {
  /** The API key. The `apiKey` credential in the send context takes precedence. */
  apiKey?: string;
  /** The API origin. Defaults to `MAILCHANNELS_API_BASE`. Tests and proxies change it. */
  baseUrl?: string;
  /**
   * Adds `dry-run=true` to the send call. MailChannels checks and renders the message,
   * answers 200, and sends no email. For tests only.
   */
  dryRun?: boolean;
  /**
   * The customer handle of your MailChannels account. The webhooks need it: they refuse
   * an event for any other account. Sending does not need it.
   */
  customerHandle?: string;
}

/** The MailChannels adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface MailchannelsAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = mailchannelsMeta.id;

function unreadable(): UnknownResult {
  return {
    status: "unknown",
    reason: "provider_error",
    message: "MailChannels accepted the request with an answer that mailswitch cannot read.",
    provider: PROVIDER,
  };
}

/**
 * Reads an accepted answer. The first entry of `results` with `status: "sent"` gives
 * `sent` with its `message_id`, at any index. An empty list, or a list with no `sent`
 * entry, is `unknown`: one personalization holds every recipient, and the docs do not say
 * that `failed` means that no recipient got the message. A dry run answers with `data`
 * and no `results`, and it is `sent` with no id.
 */
function accepted(body: unknown, dryRun: boolean): SendResult {
  const record = asRecord(body);
  if (record === undefined) return unreadable();
  if (dryRun && Array.isArray(record.data) && record.data.length > 0) {
    return { status: "sent", provider: PROVIDER };
  }
  if (!Array.isArray(record.results)) return unreadable();
  const entry = record.results.map(asRecord).find((item) => item?.status === "sent");
  if (entry === undefined) return unreadable();
  const id = stringField(entry, "message_id");
  return { status: "sent", provider: PROVIDER, ...(id ? { providerMessageId: id } : {}) };
}

function checkOptions(options: MailchannelsOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("mailchannels expects an options object.");
  }
  if (options.apiKey !== undefined && typeof options.apiKey !== "string") {
    throw new TypeError("mailchannels: apiKey must be a string.");
  }
  if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
    throw new TypeError("mailchannels: dryRun must be a boolean.");
  }
  const handle = options.customerHandle;
  if (handle !== undefined && (typeof handle !== "string" || handle.trim() === "")) {
    throw new TypeError("mailchannels: customerHandle must be a non-blank string.");
  }
  return parseBaseUrl(options.baseUrl, MAILCHANNELS_API_BASE, "mailchannels: baseUrl");
}

/**
 * Creates the MailChannels adapter.
 *
 * @throws TypeError for invalid options.
 */
export function mailchannels(options: MailchannelsOptions = {}): MailchannelsAdapter {
  const base = checkOptions(options);
  const dryRun = options.dryRun === true;
  const webhooks = mailchannelsWebhooks(PROVIDER, options.customerHandle);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": ctx.credentials.apiKey || options.apiKey || "",
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, mailchannelsMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const problem = headerProblem(message);
    if (problem !== null) {
      return withProvider(
        { status: "not_sent", reason: "invalid_message", message: problem },
        PROVIDER,
      );
    }
    const call = await callProvider({
      url: `${base}/tx/v1/send${dryRun ? "?dry-run=true" : ""}`,
      headers: headers(ctx),
      body: JSON.stringify(mailchannelsPayload(message)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) {
      await discardBody(response);
      return classifyFailure(response, mailchannelsMeta.statusMap, ctx.now, PROVIDER);
    }
    return accepted(await readJson(response), dryRun);
  }

  function verify(ctx: SendContext): Promise<VerifyResult> {
    return verifyByGet(
      {
        url: `${base}/tx/v1/usage`,
        headers: headers(ctx),
        timeoutMs: ctx.timeoutMs,
        fetch: ctx.fetch,
      },
      PROVIDER,
      mailchannelsMeta.statusMap,
      ctx.now,
    );
  }

  const adapter = defineProvider({ meta: mailchannelsMeta, send, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
