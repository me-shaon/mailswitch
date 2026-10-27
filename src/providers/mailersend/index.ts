// mailswitch/mailersend: the MailerSend adapter. It sends one message with
// `POST /v1/email` and checks the token with `GET /v1/api-quota`. MailerSend has no
// idempotency key, so the mailer store gives the only duplicate protection. Checked
// 2026-10-27.
// https://developers.mailersend.com/api/v1/email
// https://developers.mailersend.com/general
// https://developers.mailersend.com/guides/checking-api-quota
//
// A 202 does not always mean sent:
// - A 202 with the `ALL_SUPPRESSED` warning and no `x-message-id` sent nothing.
// - A 202 with `SOME_SUPPRESSED` and an `x-message-id` sent to the other recipients.
// - A 202 with `x-send-paused: true` and an `x-message-id` is accepted. MailerSend sends it
//   when the account sends again.
// - A 202 with no `x-message-id` and no warning is unknown.

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
  FailureReason,
  NotSentResult,
  OutgoingMessage,
  SendResult,
  UnknownResult,
} from "../../core/types";
import { callProvider, discardBody, parseBaseUrl, withProvider } from "../../internal/http";
import { mailersendMeta } from "./meta";
import { FIELD_LIMITS, mailersendPayload, overLimitField } from "./payload";
import { mailersendWebhooks } from "./webhooks";

export { mailersendMeta } from "./meta";
export {
  MAILERSEND_SIGNATURE_HEADER,
  mailersendSignature,
  mailersendWebhooks,
  parseMailersendEvents,
  verifyMailersendWebhook,
} from "./webhooks";

/** The MailerSend API origin. */
export const MAILERSEND_API_BASE = "https://api.mailersend.com";

/** Options of `mailersend`. */
export interface MailersendOptions {
  /** The API token. The `apiKey` credential in the send context takes precedence. */
  apiKey?: string;
  /** The API origin. Defaults to `MAILERSEND_API_BASE`. Tests and proxies change it. */
  baseUrl?: string;
}

/** The MailerSend adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface MailersendAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = mailersendMeta.id;

// Body codes of a 422 that are more exact than `invalid_message`.
// https://developers.mailersend.com/general
const CODE_REASONS: Readonly<Record<string, FailureReason>> = {
  // The from.email domain is not verified.
  MS42207: "rejected",
  // The plan or the self-set email limit is reached.
  MS42204: "quota",
  // The trial domain email quota is reached.
  MS42222: "quota",
  // The monthly overage limit is reached.
  MS42242: "quota",
};

/** Reads a body as text. Returns null when the read fails. */
async function readText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/** Finds the first `#MSxxxxx` code in the strings of the `errors` object. */
function bodyCode(text: string | null): string | undefined {
  let errors: unknown;
  try {
    errors = (JSON.parse(text ?? "") as { errors?: unknown } | null)?.errors;
  } catch {
    return undefined;
  }
  if (typeof errors !== "object" || errors === null) return undefined;
  for (const list of Object.values(errors)) {
    for (const item of Array.isArray(list) ? list : [list]) {
      const match = typeof item === "string" ? /#(MS\d{5})\b/.exec(item) : null;
      if (match) return match[1];
    }
  }
  return undefined;
}

/**
 * Classifies a failed response. A `not_sent` result of a 422 gets its reason from the
 * `#MS` code in the body. The message never copies the body.
 */
async function failure(response: Response, now: number): Promise<NotSentResult | UnknownResult> {
  const outcome = classifyResponse(response.status, response.headers, mailersendMeta.statusMap, {
    now,
  }) as NotSentResult | UnknownResult;
  if (outcome.status === "unknown" || response.status !== 422) {
    await discardBody(response);
    return withProvider(outcome, PROVIDER);
  }
  const code = bodyCode(await readText(response));
  const reason = code === undefined ? undefined : CODE_REASONS[code];
  if (reason === undefined) return withProvider(outcome, PROVIDER);
  return withProvider(
    { ...outcome, reason, message: `MailerSend answered with HTTP 422 ${code} (${reason}).` },
    PROVIDER,
  );
}

/** The `type` values of the `warnings` array of a 202 body. Null for a body it cannot read. */
function warningTypes(text: string): string[] | null {
  if (text.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const warnings = (value as { warnings?: unknown }).warnings;
  if (warnings === undefined) return [];
  if (!Array.isArray(warnings)) return null;
  return warnings.map((item: unknown) =>
    typeof item === "object" && item !== null ? String((item as { type?: unknown }).type) : "",
  );
}

/** Reads a 2xx answer. */
async function accepted(response: Response): Promise<SendResult> {
  const id = response.headers.get("x-message-id")?.trim() || undefined;
  const text = await readText(response);
  const types = text === null ? null : warningTypes(text);
  const unknown = (message: string): UnknownResult => ({
    status: "unknown",
    reason: "provider_error",
    message,
    httpStatus: response.status,
    provider: PROVIDER,
  });
  if (types === null) return unknown("MailerSend returned a body that mailswitch cannot read.");
  if (types.includes("ALL_SUPPRESSED")) {
    // The documented answer has no message id. An id with this warning contradicts it.
    if (id !== undefined) {
      return unknown("MailerSend returned a message id and the ALL_SUPPRESSED warning.");
    }
    return {
      status: "not_sent",
      reason: "rejected",
      message: "MailerSend suppressed every recipient and sent nothing (ALL_SUPPRESSED).",
      httpStatus: response.status,
      provider: PROVIDER,
    };
  }
  if (id === undefined) return unknown("MailerSend accepted the request but gave no message id.");
  return { status: "sent", provider: PROVIDER, providerMessageId: id };
}

function checkOptions(options: MailersendOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("mailersend expects an options object.");
  }
  if (options.apiKey !== undefined && typeof options.apiKey !== "string") {
    throw new TypeError("mailersend: apiKey must be a string.");
  }
  return parseBaseUrl(options.baseUrl, MAILERSEND_API_BASE, "mailersend: baseUrl");
}

/**
 * Creates the MailerSend adapter.
 *
 * @throws TypeError for invalid options.
 */
export function mailersend(options: MailersendOptions = {}): MailersendAdapter {
  const base = checkOptions(options);
  const webhooks = mailersendWebhooks(PROVIDER);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${ctx.credentials.apiKey || options.apiKey || ""}`,
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, mailersendMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const field = overLimitField(message);
    if (field !== null) {
      return withProvider(
        {
          status: "not_sent",
          reason: "unsupported",
          message: `MailerSend accepts at most ${FIELD_LIMITS[field]} ${field} recipients in one email.`,
        },
        PROVIDER,
      );
    }
    const call = await callProvider({
      url: `${base}/v1/email`,
      headers: headers(ctx),
      body: JSON.stringify(mailersendPayload(message)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now);
    return accepted(response);
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    // This call does not count against the daily API quota.
    const call = await callProvider({
      url: `${base}/v1/api-quota`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...withProvider(call.result, PROVIDER), ok: false };
    if (!call.response.ok) return { ...(await failure(call.response, ctx.now)), ok: false };
    await discardBody(call.response);
    return { ok: true };
  }

  const adapter = defineProvider({ meta: mailersendMeta, send, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
