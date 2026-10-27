// mailswitch/brevo: the Brevo API adapter. It sends one message with
// `POST /v3/smtp/email` and checks the key with `GET /v3/account`. Checked 2026-10-27.
// https://developers.brevo.com/reference/sendtransacemail
// https://developers.brevo.com/reference/getaccount
// https://developers.brevo.com/docs/how-it-works
// https://developers.brevo.com/docs/limit-headers
//
// Idempotency: Brevo takes a UUID `idempotencyKey` in the body `headers` object and keeps
// it for 30 minutes. A reused key gives the error code `duplicate_parameter`.
// https://developers.brevo.com/docs/heterogenous-versions-batch-emails
// - The adapter derives the UUID from the mailswitch key, so a retry sends the same bytes.
// - On a send with a key, `duplicate_parameter` and `duplicate_request` are `unknown`,
//   because the earlier request may have sent. Without a key they stay `not_sent`.
// - The 30-minute window is shorter than the mailswitch store window, so keep a store.
//
// Webhooks: the Brevo bearer-token check of `src/internal/brevo-webhooks.ts`. The token
// covers no timestamp and no body, so the webhook router needs a dedupe store.

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
import { brevoWebhooks } from "../../internal/brevo-webhooks";
import {
  callProvider,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import { uuidFromKey } from "../../internal/uuid";
import { brevoMeta } from "./meta";
import { brevoPayload, hasInlineAttachment } from "./payload";

export {
  BREVO_MIN_HEX_TOKEN_LENGTH,
  BREVO_MIN_TOKEN_LENGTH,
  BREVO_WEBHOOK_EVENTS,
  brevoWebhooks,
  checkBrevoWebhookToken,
  generateBrevoWebhookToken,
  parseBrevoEvents,
  verifyBrevoWebhook,
} from "../../internal/brevo-webhooks";
export { brevoMeta } from "./meta";

/** The Brevo API origin. */
export const BREVO_API_BASE = "https://api.brevo.com";

/** Options of `brevo`. */
export interface BrevoOptions {
  /** The API key. The `apiKey` credential in the send context takes precedence. */
  apiKey?: string;
  /** The API origin. Defaults to `BREVO_API_BASE`. Tests and proxies change it. */
  baseUrl?: string;
  /**
   * Turns on Brevo sandbox mode with the `X-Sib-Sandbox: drop` header. Brevo checks the
   * request and answers 201, but it sends no email. For tests only.
   */
  sandbox?: boolean;
}

/** The Brevo adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface BrevoAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

interface BrevoError {
  code?: unknown;
}

const PROVIDER = brevoMeta.id;
const AUTH_CODES = new Set(["unauthorized", "permission_denied", "account_under_validation"]);
const CREDIT_CODES = new Set(["not_enough_credits", "Insufficient credits"]);
const DUPLICATE_CODES = new Set(["duplicate_parameter", "duplicate_request"]);
const SECONDS = /^\d{1,9}(\.\d{1,3})?$/;

/**
 * Refines a `not_sent` result from the Brevo body code. On a keyed send, a duplicate code
 * changes it to `unknown`. This is the safe direction. The message never copies the body.
 */
function refine(
  result: NotSentResult,
  error: BrevoError | null,
  keyed: boolean,
): NotSentResult | UnknownResult {
  const code = typeof error?.code === "string" ? error.code : "";
  if (keyed && DUPLICATE_CODES.has(code)) {
    return {
      status: "unknown",
      reason: "idempotency_conflict",
      message: `Brevo answered with HTTP ${result.httpStatus}: the idempotency key is in use. The earlier request may have sent.`,
      ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
    };
  }
  const reason = AUTH_CODES.has(code) ? "auth" : CREDIT_CODES.has(code) ? "credits" : null;
  if (reason === null || reason === result.reason) return result;
  return {
    ...result,
    reason,
    message: `The provider answered with HTTP ${result.httpStatus} (${reason}).`,
  };
}

/**
 * Classifies a failed response. A 429 without `Retry-After` gets its delay from
 * `x-sib-ratelimit-reset`, which holds the seconds until the limit resets.
 */
async function failure(
  response: Response,
  now: number,
  keyed: boolean,
): Promise<NotSentResult | UnknownResult> {
  const outcome = classifyResponse(response.status, response.headers, brevoMeta.statusMap, {
    now,
  }) as NotSentResult | UnknownResult;
  if (outcome.status === "unknown") {
    await discardBody(response);
    return withProvider(outcome, PROVIDER);
  }
  const reset = response.headers.get("x-sib-ratelimit-reset")?.trim();
  if (
    outcome.reason === "rate_limited" &&
    outcome.retryAfterMs === undefined &&
    reset !== undefined &&
    SECONDS.test(reset)
  ) {
    outcome.retryAfterMs = Math.round(Number(reset) * 1000);
  }
  const refined = refine(outcome, (await readJson(response)) as BrevoError | null, keyed);
  return withProvider(refined, PROVIDER);
}

function checkOptions(options: BrevoOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("brevo expects an options object.");
  }
  if (options.apiKey !== undefined && typeof options.apiKey !== "string") {
    throw new TypeError("brevo: apiKey must be a string.");
  }
  if (options.sandbox !== undefined && typeof options.sandbox !== "boolean") {
    throw new TypeError("brevo: sandbox must be a boolean.");
  }
  return parseBaseUrl(options.baseUrl, BREVO_API_BASE, "brevo: baseUrl");
}

/**
 * Creates the Brevo adapter.
 *
 * @throws TypeError for invalid options.
 */
export function brevo(options: BrevoOptions = {}): BrevoAdapter {
  const base = checkOptions(options);
  const sandbox = options.sandbox === true;
  const webhooks = brevoWebhooks(PROVIDER);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": ctx.credentials.apiKey || options.apiKey || "",
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, brevoMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    if (hasInlineAttachment(message)) {
      return withProvider(
        {
          status: "not_sent",
          reason: "unsupported",
          message: "Brevo has no inline attachments. Remove the contentId of each attachment.",
        },
        PROVIDER,
      );
    }
    const keyed = message.idempotencyKey !== undefined;
    const key = keyed ? await uuidFromKey(message.idempotencyKey as string) : undefined;
    const call = await callProvider({
      url: `${base}/v3/smtp/email`,
      headers: headers(ctx),
      body: JSON.stringify(brevoPayload(message, key, sandbox)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now, keyed);
    // 201 carries `messageId`. A 2xx with no id that mailswitch can read is unknown.
    const json = (await readJson(response)) as { messageId?: unknown; messageIds?: unknown } | null;
    const id =
      typeof json?.messageId === "string"
        ? json.messageId
        : Array.isArray(json?.messageIds) && typeof json.messageIds[0] === "string"
          ? json.messageIds[0]
          : undefined;
    if (id === undefined || id === "") {
      return {
        status: "unknown",
        reason: "provider_error",
        message: `Brevo answered with HTTP ${response.status} and no message id that mailswitch can read.`,
        httpStatus: response.status,
        provider: PROVIDER,
      };
    }
    return { status: "sent", provider: PROVIDER, providerMessageId: id };
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const call = await callProvider({
      url: `${base}/v3/account`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...withProvider(call.result, PROVIDER), ok: false };
    if (!call.response.ok) return { ...(await failure(call.response, ctx.now, false)), ok: false };
    await discardBody(call.response);
    return { ok: true };
  }

  const adapter = defineProvider({ meta: brevoMeta, send, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
