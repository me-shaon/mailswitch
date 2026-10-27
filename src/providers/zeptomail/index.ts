// mailswitch/zeptomail: the ZeptoMail adapter. It sends one message with
// `POST /v1.1/email` on the `api.zeptomail.<tld>` host of the region. The token goes in
// `Authorization: Zoho-enczapikey <token>`. ZeptoMail has no idempotency key, so the
// mailer store gives the only duplicate protection. ZeptoMail is now part of Zoho CPaaS.
// The keys and the hosts stay the same. Checked 2026-10-27.
// https://www.zoho.com/zeptomail/help/api/email-sending.html
// https://www.zoho.com/zeptomail/help/api/error-codes.html
// https://www.zoho.com/blog/cpaas/zeptomail-is-now-zoho-cpaas.html
//
// - A 2xx with `data[0].code` `EM_104` is `sent`, with `request_id` as the message id.
//   Any other 2xx body is `unknown`.
// - A 4xx reason is refined from the error code. Both documented error shapes are read:
//   `{ error: { code, details: [{ code }] } }` and `{ data: { error_code } }`.
// - Every 5xx is `unknown`.
//
// ZeptoMail has no read call for a token. So `verify` sends a request that cannot deliver
// email: a `from` and a `subject`, with no recipient field (KTD9). A 400 `TM_3201`
// (mandatory field missing) means that the token passed. A 401 `TM_4001` means a bad token.

import {
  defineProvider,
  type ProviderAdapter,
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
import { credentialOrOption } from "../../internal/credential";
import { callProvider, discardBody, readJson, withProvider } from "../../internal/http";
import { zeptomailMeta } from "./meta";
import { zeptomailPayload } from "./payload";

export { zeptomailMeta } from "./meta";

/** The API origin of each ZeptoMail region. The default region is `com`. */
export const ZEPTOMAIL_HOSTS: Readonly<Record<ZeptomailRegion, string>> = Object.freeze({
  com: "https://api.zeptomail.com",
  eu: "https://api.zeptomail.eu",
  in: "https://api.zeptomail.in",
  "com.au": "https://api.zeptomail.com.au",
  jp: "https://api.zeptomail.jp",
  ca: "https://api.zeptomail.ca",
  sa: "https://api.zeptomail.sa",
});

/** A ZeptoMail region: the domain ending of the account. */
export type ZeptomailRegion = "com" | "eu" | "in" | "com.au" | "jp" | "ca" | "sa";

/** The scheme of the ZeptoMail `Authorization` header. */
export const ZEPTOMAIL_AUTH_SCHEME = "Zoho-enczapikey";

/** Options of `zeptomail`. Each credential field takes precedence over its option. */
export interface ZeptomailOptions {
  /** The Send Mail token, with or without the `Zoho-enczapikey ` prefix. */
  token?: string;
  /** The region of the account. Without it, the adapter uses `com`. */
  region?: ZeptomailRegion;
  /** The sender of the verify request. Without it, verify uses `verify@<region host>`. */
  fromAddress?: string;
}

const PROVIDER = zeptomailMeta.id;
const CODE = /^[A-Z]{1,8}_\d{1,6}$/;
const PREFIX = /^Zoho-enczapikey\s+/i;

/** The 4xx reason of each ZeptoMail error code. */
const REASONS: Readonly<Record<string, FailureReason>> = {
  TM_4001: "auth",
  SERR_157: "auth",
  SERR_156: "auth",
  AE_101: "auth",
  SMI_115: "quota",
  SM_133: "quota",
  LE_101: "credits",
  LE_102: "credits",
  SM_111: "rejected",
  SM_113: "rejected",
  SM_128: "rejected",
  TM_8001: "invalid_message",
  TM_3201: "invalid_message",
};

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

/** The error codes of an answer, top code first. Only well-formed codes are kept. */
function errorCodes(json: unknown): string[] {
  const body = record(json);
  const error = record(body?.error);
  const details = Array.isArray(error?.details) ? (error.details as unknown[]) : [];
  return [
    error?.code,
    ...details.map((item) => record(item)?.code),
    record(body?.data)?.error_code,
  ].filter((code): code is string => typeof code === "string" && CODE.test(code));
}

function isRegion(value: string): value is ZeptomailRegion {
  return Object.hasOwn(ZEPTOMAIL_HOSTS, value);
}

/** Refines the reason of a `not_sent` result from the first known error code. */
function refine(result: NotSentResult, codes: readonly string[]): NotSentResult {
  const code = codes.find((item) => Object.hasOwn(REASONS, item));
  const reason = code === undefined ? result.reason : (REASONS[code] as FailureReason);
  const named = code ?? codes[0];
  return {
    ...result,
    reason,
    message: `ZeptoMail answered with HTTP ${result.httpStatus}${named ? ` ${named}` : ""} (${reason}).`,
  };
}

/** Classifies a failed response. Only a 4xx body is read, and only its codes are kept. */
async function failure(
  response: Response,
  now: number,
): Promise<{ result: NotSentResult | UnknownResult; codes: string[] }> {
  const outcome = classifyResponse(response.status, response.headers, zeptomailMeta.statusMap, {
    now,
  }) as NotSentResult | UnknownResult;
  if (outcome.status === "unknown") {
    await discardBody(response);
    return { result: withProvider(outcome, PROVIDER), codes: [] };
  }
  const codes = errorCodes(await readJson(response));
  return { result: withProvider(refine(outcome, codes), PROVIDER), codes };
}

function unclear(httpStatus: number, message: string): UnknownResult {
  return { status: "unknown", reason: "provider_error", message, httpStatus, provider: PROVIDER };
}

/** Reads a 2xx send answer. Only `EM_104` is `sent`. */
function sentResult(json: unknown, httpStatus: number): SendResult {
  const body = record(json);
  const first = Array.isArray(body?.data) ? record(body.data[0]) : undefined;
  if (first?.code !== "EM_104") {
    return unclear(httpStatus, "ZeptoMail gave no clear result for this email.");
  }
  const id = body?.request_id;
  return {
    status: "sent",
    provider: PROVIDER,
    ...(typeof id === "string" && id !== "" ? { providerMessageId: id } : {}),
  };
}

function checkOptions(options: ZeptomailOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("zeptomail expects an options object.");
  }
  for (const name of ["token", "fromAddress"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "string") {
      throw new TypeError(`zeptomail: ${name} must be a string.`);
    }
  }
  if (options.region !== undefined && !isRegion(String(options.region))) {
    throw new TypeError(
      'zeptomail: region must be "com", "eu", "in", "com.au", "jp", "ca", or "sa".',
    );
  }
}

/** Creates the ZeptoMail adapter. Throws a TypeError for invalid options. */
export function zeptomail(options: ZeptomailOptions = {}): ProviderAdapter {
  checkOptions(options);

  /** The origin of the region, or undefined for a region that ZeptoMail does not have. */
  function origin(ctx: SendContext): string | undefined {
    const region = credentialOrOption(
      ctx.credentials,
      ctx.defaultedFields,
      "region",
      options.region,
    ).toLowerCase();
    if (region === "") return ZEPTOMAIL_HOSTS.com;
    return isRegion(region) ? ZEPTOMAIL_HOSTS[region] : undefined;
  }

  async function post(base: string, body: unknown, ctx: SendContext) {
    const token = (ctx.credentials.token || options.token || "").trim().replace(PREFIX, "");
    return callProvider({
      url: `${base}/v1.1/email`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `${ZEPTOMAIL_AUTH_SCHEME} ${token}`,
      },
      body: JSON.stringify(body),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
  }

  const badRegion = (): NotSentResult => ({
    status: "not_sent",
    reason: "auth",
    message: "The ZeptoMail region is not one of com, eu, in, com.au, jp, ca, or sa.",
    provider: PROVIDER,
  });

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, zeptomailMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const base = origin(ctx);
    if (base === undefined) return badRegion();
    const call = await post(base, zeptomailPayload(message), ctx);
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) return (await failure(response, ctx.now)).result;
    return sentResult(await readJson(response), response.status);
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const base = origin(ctx);
    if (base === undefined) return { ...badRegion(), ok: false };
    const from =
      credentialOrOption(
        ctx.credentials,
        ctx.defaultedFields,
        "fromAddress",
        options.fromAddress,
      ) || `verify@${new URL(base).hostname}`;
    // No to, cc, or bcc field: this request cannot deliver email.
    const call = await post(
      base,
      { from: { address: from }, subject: "mailswitch credential check" },
      ctx,
    );
    if (!call.ok) return { ...withProvider(call.result, PROVIDER), ok: false };
    const { response } = call;
    if (response.ok) {
      await discardBody(response);
      return {
        ...unclear(response.status, "ZeptoMail accepted the verify request. It should refuse it."),
        ok: false,
      };
    }
    const { result, codes } = await failure(response, ctx.now);
    // Verify reads TM_3201 with its own rule: the token passed, and the request had no
    // recipient. In a send, TM_3201 stays invalid_message.
    if (response.status === 400 && codes.includes("TM_3201")) return { ok: true };
    return { ...result, ok: false };
  }

  return defineProvider({ meta: zeptomailMeta, send, verify });
}
