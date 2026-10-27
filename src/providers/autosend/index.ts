// mailswitch/autosend: the AutoSend adapter. It sends one message with
// `POST /v1/mails/send` and checks the key with `GET /v1/domains`. The key goes in
// `Authorization: Bearer`. An account key (`ASA_`) also needs the `x-project-id` header.
// AutoSend has no idempotency key, so the mailer store gives the only duplicate
// protection. Checked 2026-10-27.
// https://docs.autosend.com/api-reference/mails/send.md
// https://docs.autosend.com/api-keys.md
// https://docs.autosend.com/api-reference/errors.md
// https://docs.autosend.com/api-reference/rate-limit.md
//
// - AutoSend takes one `to` object. A message with more than one To address is refused
//   before the request as `not_sent/unsupported`, so one message keeps one result.
// - A 2xx with `success: true` and `data.emailId` is `sent`. Any other 2xx is `unknown`.
// - A 4xx reason is refined from the body code. Both error shapes are read:
//   `{ error: { code, retryAfter } }` and `{ code, retryAfter }`.
// - A 429 with no `Retry-After` takes `retryAfter` from the body, as seconds, at most one
//   hour.
// - Every 5xx is `unknown`.

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { validateMessage } from "../../core/message";
import type {
  FailureReason,
  NotSentResult,
  OutgoingMessage,
  SendResult,
  UnknownResult,
} from "../../core/types";
import { credentialOrOption } from "../../internal/credential";
import { callProvider, parseBaseUrl, readJson, withProvider } from "../../internal/http";
import { asRecord, numberField } from "../../internal/json";
import { classifyWithBody, verifyByGet } from "../../internal/verify";
import { autosendMeta } from "./meta";
import { autosendPayload, autosendRefusal } from "./payload";
import { autosendWebhooks } from "./webhooks";

export { autosendMeta } from "./meta";
export {
  AUTOSEND_SIGNATURE_HEADER,
  autosendSignature,
  autosendWebhooks,
  parseAutosendEvents,
  verifyAutosendWebhook,
} from "./webhooks";

/** The AutoSend API origin. */
export const AUTOSEND_API_BASE = "https://api.autosend.com";

/** Options of `autosend`. Each credential field takes precedence over its option. */
export interface AutosendOptions {
  /** The API key, `AS_...` for a project or `ASA_...` for the account. */
  apiKey?: string;
  /** The project id. An account key needs it. A project key does not. */
  projectId?: string;
  /** The API origin. Defaults to `AUTOSEND_API_BASE`. Tests and proxies change it. */
  baseUrl?: string;
}

/** The AutoSend adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface AutosendAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = autosendMeta.id;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ACCOUNT_KEY = /^asa_/i;
const MAX_RETRY_AFTER_MS = 3_600_000;

// The 4xx reason of each AutoSend error code.
// https://docs.autosend.com/api-reference/errors.md
const REASONS: Readonly<Record<string, FailureReason>> = {
  VALIDATION_FAILED: "invalid_message",
  UNAUTHORIZED: "auth",
  PLAN_UPGRADE_REQUIRED: "credits",
  INSUFFICIENT_PERMISSIONS: "auth",
  NOT_FOUND: "rejected",
  RATE_LIMIT_EXCEEDED: "rate_limited",
};

/** The error record of an answer: the nested `error` object, or the flat body. */
function errorRecord(json: unknown): Record<string, unknown> | undefined {
  const body = asRecord(json);
  return asRecord(body?.error) ?? body;
}

/**
 * Refines a `not_sent` result from the body code, and reads `retryAfter` when no
 * `Retry-After` header gave a value. It changes only the reason and the wait time. The
 * message never copies the body.
 */
function refine(result: NotSentResult, json: unknown): NotSentResult {
  const error = errorRecord(json);
  const raw = error?.code;
  const code = typeof raw === "string" && CODE.test(raw) ? raw : undefined;
  const reason = code !== undefined && Object.hasOwn(REASONS, code) ? REASONS[code] : undefined;
  const out: NotSentResult = { ...result };
  if (reason !== undefined) out.reason = reason;
  if (code !== undefined) {
    out.message = `AutoSend answered with HTTP ${result.httpStatus} ${code} (${out.reason}).`;
  }
  if (out.retryAfterMs === undefined && result.httpStatus === 429) {
    const seconds = error === undefined ? undefined : numberField(error, "retryAfter");
    if (seconds !== undefined && seconds >= 0) {
      out.retryAfterMs = Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
    }
  }
  return out;
}

/** Classifies a failed response. Only a `not_sent` body is read. */
function failure(response: Response, now: number): Promise<NotSentResult | UnknownResult> {
  return classifyWithBody(response, autosendMeta.statusMap, now, PROVIDER, refine);
}

/** Reads a 2xx send answer. Only `success: true` with a string `data.emailId` is `sent`. */
function accepted(json: unknown, httpStatus: number): SendResult {
  const body = asRecord(json);
  const id = asRecord(body?.data)?.emailId;
  if (body?.success === true && typeof id === "string" && id.trim() !== "") {
    return { status: "sent", provider: PROVIDER, providerMessageId: id.trim() };
  }
  return {
    status: "unknown",
    reason: "provider_error",
    message: "AutoSend accepted the request with an answer that mailswitch cannot read.",
    httpStatus,
    provider: PROVIDER,
  };
}

function checkOptions(options: AutosendOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("autosend expects an options object.");
  }
  for (const name of ["apiKey", "projectId"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "string") {
      throw new TypeError(`autosend: ${name} must be a string.`);
    }
  }
  return parseBaseUrl(options.baseUrl, AUTOSEND_API_BASE, "autosend: baseUrl");
}

/**
 * Creates the AutoSend adapter.
 *
 * @throws TypeError for invalid options.
 */
export function autosend(options: AutosendOptions = {}): AutosendAdapter {
  const base = checkOptions(options);
  const webhooks = autosendWebhooks(PROVIDER);

  /** The request headers, or null for an account key with no project id. */
  function headers(ctx: SendContext): Record<string, string> | null {
    const apiKey = (ctx.credentials.apiKey || options.apiKey || "").trim();
    const projectId = credentialOrOption(
      ctx.credentials,
      ctx.defaultedFields,
      "projectId",
      options.projectId,
    ).trim();
    if (ACCOUNT_KEY.test(apiKey) && projectId === "") return null;
    return {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(projectId === "" ? {} : { "x-project-id": projectId }),
    };
  }

  const noProject = (): NotSentResult => ({
    status: "not_sent",
    reason: "auth",
    message: "An AutoSend account key (ASA_) needs a project ID.",
    provider: PROVIDER,
  });

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, autosendMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const refusal = autosendRefusal(message);
    if (refusal !== null) {
      return { status: "not_sent", reason: "unsupported", message: refusal, provider: PROVIDER };
    }
    const sendHeaders = headers(ctx);
    if (sendHeaders === null) return noProject();
    const call = await callProvider({
      url: `${base}/v1/mails/send`,
      headers: sendHeaders,
      body: JSON.stringify(autosendPayload(message)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now);
    return accepted(await readJson(response), response.status);
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const verifyHeaders = headers(ctx);
    if (verifyHeaders === null) return { ...noProject(), ok: false };
    // The domain list is an authenticated read. It sends no email. An empty list is ok.
    return verifyByGet(
      {
        url: `${base}/v1/domains`,
        headers: verifyHeaders,
        timeoutMs: ctx.timeoutMs,
        fetch: ctx.fetch,
      },
      PROVIDER,
      autosendMeta.statusMap,
      ctx.now,
      (response) => failure(response, ctx.now),
    );
  }

  const adapter = defineProvider({ meta: autosendMeta, send, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
