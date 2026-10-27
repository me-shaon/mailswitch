// mailswitch/sendgrid: the SendGrid adapter. It sends one message with
// `POST /v3/mail/send` and checks the key with `GET /v3/scopes`. SendGrid has no
// idempotency key, so the mailer store gives the only duplicate protection. Checked
// 2026-10-27.
// https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
// https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access
// https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/rate-limits

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
import {
  callProvider,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import { sendgridMeta } from "./meta";
import { hasNonAsciiFromName, sendgridPayload } from "./payload";
import { sendgridWebhooks } from "./webhooks";

export { sendgridMeta } from "./meta";
export {
  parseSendgridEvents,
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
  SENDGRID_WEBHOOK_TOLERANCE_MS,
  sendgridSignedPayload,
  sendgridWebhooks,
  verifySendgridWebhook,
} from "./webhooks";

/** The SendGrid API origin. */
export const SENDGRID_API_BASE = "https://api.sendgrid.com";
/** The SendGrid API origin of EU regional subusers. Pass it as `baseUrl`. */
export const SENDGRID_EU_API_BASE = "https://api.eu.sendgrid.com";

/** Options of `sendgrid`. */
export interface SendgridOptions {
  /** The API key. The `apiKey` credential in the send context takes precedence. */
  apiKey?: string;
  /**
   * The API origin. Defaults to `SENDGRID_API_BASE`. Set `SENDGRID_EU_API_BASE` for an
   * EU regional subuser.
   */
  baseUrl?: string;
  /**
   * Turns on SendGrid sandbox mode. SendGrid checks the request and answers 200, but it
   * delivers no email. For tests only.
   */
  sandbox?: boolean;
}

/** The SendGrid adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface SendgridAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = sendgridMeta.id;

/**
 * Classifies a failed response. SendGrid error bodies carry no code that is more exact
 * than the HTTP status, so the body is not read. A 429 without `Retry-After` gets its
 * delay from `X-RateLimit-Reset`, which holds Unix seconds.
 */
async function failure(response: Response, now: number): Promise<NotSentResult | UnknownResult> {
  await discardBody(response);
  const outcome = classifyResponse(response.status, response.headers, sendgridMeta.statusMap, {
    now,
  }) as NotSentResult | UnknownResult;
  const reset = response.headers.get("x-ratelimit-reset");
  if (
    outcome.reason === "rate_limited" &&
    outcome.retryAfterMs === undefined &&
    reset !== null &&
    /^\d{1,12}$/.test(reset.trim())
  ) {
    outcome.retryAfterMs = Math.max(0, Number(reset.trim()) * 1000 - now);
  }
  return withProvider(outcome, PROVIDER);
}

function checkOptions(options: SendgridOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("sendgrid expects an options object.");
  }
  if (options.sandbox !== undefined && typeof options.sandbox !== "boolean") {
    throw new TypeError("sendgrid: sandbox must be a boolean.");
  }
  return parseBaseUrl(options.baseUrl, SENDGRID_API_BASE, "sendgrid: baseUrl");
}

/**
 * Creates the SendGrid adapter.
 *
 * @throws TypeError for invalid options.
 */
export function sendgrid(options: SendgridOptions = {}): SendgridAdapter {
  const base = checkOptions(options);
  const sandbox = options.sandbox === true;
  const webhooks = sendgridWebhooks(PROVIDER);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      // SendGrid answers 406 when the Accept header is missing.
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${ctx.credentials.apiKey || options.apiKey || ""}`,
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, sendgridMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    if (hasNonAsciiFromName(message)) {
      return withProvider(
        {
          status: "not_sent",
          reason: "unsupported",
          message: "SendGrid does not accept a from name with characters outside ASCII.",
        },
        PROVIDER,
      );
    }
    const call = await callProvider({
      url: `${base}/v3/mail/send`,
      headers: headers(ctx),
      body: JSON.stringify(sendgridPayload(message, sandbox)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now);
    // 202 is the normal answer. Sandbox mode answers 200. The body is empty.
    const id = response.headers.get("x-message-id");
    await discardBody(response);
    return {
      status: "sent",
      provider: PROVIDER,
      ...(id ? { providerMessageId: id } : {}),
    };
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const call = await callProvider({
      url: `${base}/v3/scopes`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...withProvider(call.result, PROVIDER), ok: false };
    if (!call.response.ok) return { ...(await failure(call.response, ctx.now)), ok: false };
    const scopes = ((await readJson(call.response)) as { scopes?: unknown } | null)?.scopes;
    if (!Array.isArray(scopes)) {
      return {
        ok: false,
        status: "unknown",
        reason: "provider_error",
        message: "SendGrid returned a scope list that mailswitch cannot read.",
        provider: PROVIDER,
      };
    }
    if (!scopes.includes("mail.send")) {
      return {
        ok: false,
        status: "not_sent",
        reason: "auth",
        message: "The SendGrid API key does not have the mail.send permission.",
        provider: PROVIDER,
      };
    }
    return { ok: true };
  }

  const adapter = defineProvider({ meta: sendgridMeta, send, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
