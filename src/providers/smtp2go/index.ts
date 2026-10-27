// mailswitch/smtp2go: the SMTP2GO adapter. It sends one message with
// `POST /v3/email/send` and checks the key with `POST /v3/api_keys/permissions`. The key
// goes in the `X-Smtp2go-Api-Key` header, never in the body. SMTP2GO has no idempotency
// key, so the mailer store gives the only duplicate protection. Checked 2026-10-27.
// https://developers.smtp2go.com/reference/send-standard-email.md
// https://developers.smtp2go.com/reference/view-api-key-permissions.md
// https://developers.smtp2go.com/docs/response-codes
// https://developers.smtp2go.com/docs/rate-limiting.md
//
// "This endpoint returns 200 OK even if there are errors in the response", so a 200 is
// read from the body. The counts are per email:
// - `succeeded > 0` is `sent` with `email_id`, even when `failed > 0`.
// - `succeeded: 0` with `failed > 0` is `not_sent/rejected`.
// - Any other 2xx body is `unknown`.
// A 400 whose error names the API key is `not_sent/auth`. A 429 has no Retry-After
// header, so the result waits the documented minimum of 60 s. Every 5xx is `unknown`.

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { validateMessage } from "../../core/message";
import type { NotSentResult, OutgoingMessage, SendResult, UnknownResult } from "../../core/types";
import {
  callProvider,
  classifyFailure,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import { asRecord } from "../../internal/json";
import { smtp2goMeta } from "./meta";
import { smtp2goPayload } from "./payload";
import { type Smtp2goWebhookOptions, smtp2goWebhooks } from "./webhooks";

export { smtp2goMeta } from "./meta";
export {
  checkSmtp2goWebhookSecret,
  generateSmtp2goWebhookSecret,
  parseSmtp2goEvents,
  SMTP2GO_WEBHOOK_USERNAME,
  type Smtp2goWebhookAuth,
  type Smtp2goWebhookOptions,
  smtp2goWebhookAuth,
  smtp2goWebhooks,
} from "./webhooks";

/** The API origin of each SMTP2GO region. `global` is the regionless host. */
export const SMTP2GO_REGIONS: Readonly<{ global: string; us: string; eu: string; au: string }> =
  Object.freeze({
    global: "https://api.smtp2go.com",
    us: "https://us-api.smtp2go.com",
    eu: "https://eu-api.smtp2go.com",
    au: "https://au-api.smtp2go.com",
  });

/** An SMTP2GO region. */
export type Smtp2goRegion = "us" | "eu" | "au";

/** The most addresses that SMTP2GO takes in each of To, Cc, and Bcc. */
export const SMTP2GO_MAX_FIELD_RECIPIENTS = 100;
/** The wait after a 429, in milliseconds: "no less than 1 minute". */
export const SMTP2GO_RATE_LIMIT_WAIT_MS = 60_000;

/** Options of `smtp2go`. */
export interface Smtp2goOptions {
  /** The API key. The `apiKey` credential in the send context takes precedence. */
  apiKey?: string;
  /** The region host. Without it, the adapter uses the regionless `api.smtp2go.com`. */
  region?: Smtp2goRegion;
  /** The API origin, for tests or a proxy. It replaces the region origin. */
  baseUrl?: string;
  /** The Basic auth username of the webhook. Defaults to `SMTP2GO_WEBHOOK_USERNAME`. */
  webhookUsername?: string;
  /**
   * The webhook secret before a rotation. While it is set, both the current secret (the
   * `secret` of `handleWebhook`) and this one pass.
   */
  previousWebhookSecret?: string;
}

/** The SMTP2GO adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface Smtp2goAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = smtp2goMeta.id;
const ERROR_CODE = /^E_ApiResponseCodes\.[A-Z_]{1,64}$/;
// The error codes and texts that identify the API key. Observed 2026-10-27: a wrong key
// gives 400 API_EXCEPTION "An API User matching the passed 'api_key' was not found". The
// send reference shows 400 ENDPOINT_PERMISSION_DENIED for a key without the permission.
// ERROR_CODE has checked the `E_ApiResponseCodes.` prefix before these run.
const KEY_CODE = /\.(API_EXCEPTION|INVALID_IN_PAYLOAD)$/;
const DENIED = /\.ENDPOINT_PERMISSION_DENIED$/;
const KEY_TEXT = /'api_key'/;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function unclear(httpStatus: number): UnknownResult {
  return {
    status: "unknown",
    reason: "provider_error",
    message: "SMTP2GO gave no clear result for this email.",
    httpStatus,
    provider: PROVIDER,
  };
}

/** Reads a 2xx send answer. The result never copies `failures`. */
function sentResult(json: unknown, httpStatus: number): SendResult {
  const data = asRecord(asRecord(json)?.data);
  const succeeded = count(data?.succeeded);
  const failed = count(data?.failed);
  if (succeeded !== undefined && succeeded > 0) {
    const id = data?.email_id;
    return {
      status: "sent",
      provider: PROVIDER,
      ...(typeof id === "string" && id !== "" ? { providerMessageId: id } : {}),
    };
  }
  if (succeeded === 0 && failed !== undefined && failed > 0) {
    return {
      status: "not_sent",
      reason: "rejected",
      message: `SMTP2GO refused this email for ${failed} recipient(s) and sent it to none.`,
      httpStatus,
      provider: PROVIDER,
    };
  }
  return unclear(httpStatus);
}

/**
 * Classifies a failed response. Only a 400 body is read, to find an API key error. The
 * result holds the `error_code` and never the `error` text.
 */
async function failure(response: Response, now: number): Promise<NotSentResult | UnknownResult> {
  const outcome = classifyFailure(response, smtp2goMeta.statusMap, now, PROVIDER);
  if (response.status !== 400) {
    await discardBody(response);
    if (outcome.status === "not_sent" && outcome.reason === "rate_limited") {
      outcome.retryAfterMs ??= SMTP2GO_RATE_LIMIT_WAIT_MS;
    }
    return outcome;
  }
  const data = asRecord(asRecord(await readJson(response))?.data);
  const code = data?.error_code;
  if (typeof code !== "string" || !ERROR_CODE.test(code)) return outcome;
  const keyError =
    DENIED.test(code) ||
    (KEY_CODE.test(code) && typeof data?.error === "string" && KEY_TEXT.test(data.error));
  const reason = keyError ? "auth" : outcome.reason;
  return { ...outcome, reason, message: `SMTP2GO answered with HTTP 400 ${code} (${reason}).` };
}

function checkOptions(options: Smtp2goOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("smtp2go expects an options object.");
  }
  for (const name of ["apiKey", "webhookUsername"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "string") {
      throw new TypeError(`smtp2go: ${name} must be a string.`);
    }
  }
  const region = options.region;
  if (region !== undefined && region !== "us" && region !== "eu" && region !== "au") {
    throw new TypeError('smtp2go: region must be "us", "eu", or "au".');
  }
  return parseBaseUrl(options.baseUrl, SMTP2GO_REGIONS[region ?? "global"], "smtp2go: baseUrl");
}

/** The first field of To, Cc, and Bcc with more than 100 addresses, or undefined. */
function crowdedField(message: OutgoingMessage): string | undefined {
  for (const name of ["to", "cc", "bcc"] as const) {
    if ((message[name]?.length ?? 0) > SMTP2GO_MAX_FIELD_RECIPIENTS) return name;
  }
  return undefined;
}

/**
 * Creates the SMTP2GO adapter.
 *
 * @throws TypeError for invalid options, an unknown region, an invalid webhook username,
 * or a `previousWebhookSecret` with less than 128 bits.
 */
export function smtp2go(options: Smtp2goOptions = {}): Smtp2goAdapter {
  const base = checkOptions(options);
  const hookOptions: Smtp2goWebhookOptions = {};
  if (options.webhookUsername !== undefined) hookOptions.username = options.webhookUsername;
  if (options.previousWebhookSecret !== undefined) {
    hookOptions.previousSecret = options.previousWebhookSecret;
  }
  const webhooks = smtp2goWebhooks(PROVIDER, hookOptions);

  function post(path: string, body: string, ctx: SendContext) {
    return callProvider({
      url: `${base}/v3${path}`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-smtp2go-api-key": ctx.credentials.apiKey || options.apiKey || "",
      },
      body,
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, smtp2goMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const field = crowdedField(message);
    if (field !== undefined) {
      return withProvider(
        {
          status: "not_sent",
          reason: "unsupported",
          message: `The ${field} field has more than ${SMTP2GO_MAX_FIELD_RECIPIENTS} addresses. SMTP2GO takes at most ${SMTP2GO_MAX_FIELD_RECIPIENTS}.`,
        },
        PROVIDER,
      );
    }
    const call = await post("/email/send", JSON.stringify(smtp2goPayload(message)), ctx);
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now);
    return sentResult(await readJson(response), response.status);
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const call = await post("/api_keys/permissions", "{}", ctx);
    if (!call.ok) return { ...withProvider(call.result, PROVIDER), ok: false };
    const { response } = call;
    if (!response.ok) return { ...(await failure(response, ctx.now)), ok: false };
    const list = asRecord(await readJson(response))?.data;
    if (!Array.isArray(list)) return { ...unclear(response.status), ok: false };
    if (list.includes("/email/send")) return { ok: true };
    return {
      ok: false,
      status: "not_sent",
      reason: "auth",
      message: "The SMTP2GO API key has no permission for /email/send.",
      httpStatus: response.status,
      provider: PROVIDER,
    };
  }

  const adapter = defineProvider({ meta: smtp2goMeta, send, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
