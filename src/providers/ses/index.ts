// mailswitch/ses: the Amazon SES adapter. It sends with the SES v2 SendEmail call
// (`POST /v2/email/outbound-emails`) and checks the credentials with GetAccount
// (`GET /v2/email/account`). Requests are signed with SigV4 on Web Crypto.
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html
//
// Every message uses `Content.Simple`, also with attachments: SES v2 accepts them in
// `Content.Simple.Attachments`, so no raw MIME is built.
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Message.html
//
// SES has no idempotency key. SNS delivers the webhooks. See `sns-verify.ts`.

import {
  defineProvider,
  type ProviderAdapter,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { classifyResponse } from "../../core/classify";
import { validateMessage } from "../../core/message";
import type { NotSentResult, OutgoingMessage, SendResult, UnknownResult } from "../../core/types";
import { bytesToBase64 } from "../../internal/encoding";
import { callProvider, discardBody, type ProviderCall, readJson } from "../../internal/http";
import { encodeMailbox } from "../../internal/mime";
import { type SigV4Credentials, type SigV4Request, signRequest } from "../../internal/sigv4";
import { parseSesEvents } from "./events";
import { sesMeta } from "./meta";
import { createSnsVerifier, type SnsVerifyOptions } from "./sns-verify";

export {
  parseSesEvents,
  type SesEvent,
  type SnsConfirmAction,
  snsConfirmAction,
} from "./events";
export { sesMeta } from "./meta";
export {
  createSnsVerifier,
  isSnsCertUrl,
  isSnsSubscribeUrl,
  parseSnsMessage,
  parseTopicAllowlist,
  parseTopicArn,
  SNS_CERT_MAX_BYTES,
  SNS_CERT_TIMEOUT_MS,
  SNS_CERT_TTL_MS,
  SNS_MAX_AGE_MS,
  SNS_MAX_FUTURE_MS,
  type SnsMessage,
  type SnsVerifyOptions,
  snsStringToSign,
  type TopicArn,
} from "./sns-verify";

/** SES v2 `Content.Simple.Headers` holds at most 15 headers. */
export const SES_MAX_HEADERS = 15;

/** Options of `ses`. */
export interface SesOptions extends SnsVerifyOptions {
  /** The AWS region. The region in `SendContext.credentials` takes precedence. */
  region?: string;
  /** The access key ID. The value in `SendContext.credentials` takes precedence. */
  accessKeyId?: string;
  /** The secret access key. The value in `SendContext.credentials` takes precedence. */
  secretAccessKey?: string;
  /** The session token of temporary credentials. */
  sessionToken?: string;
  /** The SES configuration set of each message, for event publishing to SNS. */
  configurationSetName?: string;
  /**
   * The API origin. Defaults to `https://email.<region>.amazonaws.com`. Tests and VPC
   * endpoints change it. The signature still uses the region of the credentials.
   */
  endpoint?: string;
}

interface SesError {
  message?: unknown;
  Message?: unknown;
  __type?: unknown;
  code?: unknown;
}

const PROVIDER = sesMeta.id;
// SES error names without the `Exception` suffix, by the reason that they refine to.
const AUTH_ERRORS =
  /^(AccessDenied|AccountSuspended|ExpiredToken|IncompleteSignature|InvalidClientTokenId|InvalidSignature|MissingAuthenticationToken|SendingPaused|SignatureDoesNotMatch|UnrecognizedClient)$/;
const QUOTA_TEXT = /daily message quota|maximum sending quota|sending quota exceeded/i;

function tag<T extends NotSentResult | UnknownResult>(result: T): T {
  return { ...result, provider: PROVIDER };
}

/**
 * The SES error name, from `x-amzn-ErrorType` or the body, without the `Exception`
 * suffix. For example `MessageRejected` or `TooManyRequests`.
 */
function errorName(response: Response, body: SesError | null): string {
  const raw = response.headers.get("x-amzn-errortype") ?? String(body?.__type ?? body?.code ?? "");
  return (raw.split(":")[0]?.split("#").pop() ?? "").replace(/Exception$/, "");
}

/**
 * Refines the reason of a `not_sent` result with the SES error name. The status never
 * changes. The message keeps the fixed text and never copies the response body.
 */
function refine(result: NotSentResult, name: string, text: string): NotSentResult {
  let reason = result.reason;
  if (QUOTA_TEXT.test(text) || name === "LimitExceeded") reason = "quota";
  else if (/^(TooManyRequests|Throttling)$/.test(name)) reason = "rate_limited";
  else if (AUTH_ERRORS.test(name)) reason = "auth";
  else if (/^(MessageRejected|MailFromDomainNotVerified)$/.test(name)) reason = "rejected";
  else if (/^(BadRequest|NotFound)$/.test(name)) reason = "invalid_message";
  if (reason === result.reason) return result;
  return {
    ...result,
    reason,
    message: `The provider answered with HTTP ${result.httpStatus} (${reason}).`,
  };
}

async function failure(
  response: Response,
  ctx: SendContext,
): Promise<NotSentResult | UnknownResult | null> {
  const outcome = classifyResponse(response.status, response.headers, sesMeta.statusMap, {
    now: ctx.now,
  });
  if (outcome.status === "sent") return null;
  if (outcome.status === "unknown") {
    await discardBody(response);
    return tag(outcome);
  }
  const body = (await readJson(response)) as SesError | null;
  const text = String(body?.message ?? body?.Message ?? "");
  return tag(refine(outcome, errorName(response, body), text));
}

/** The SES v2 SendEmail body of one message. */
export function sesPayload(
  message: OutgoingMessage,
  configurationSetName?: string,
): Record<string, unknown> {
  const destination: Record<string, string[]> = { ToAddresses: message.to.map(encodeMailbox) };
  if (message.cc?.length) destination.CcAddresses = message.cc.map(encodeMailbox);
  if (message.bcc?.length) destination.BccAddresses = message.bcc.map(encodeMailbox);
  const body: Record<string, unknown> = {};
  if (message.html) body.Html = { Data: message.html, Charset: "UTF-8" };
  if (message.text) body.Text = { Data: message.text, Charset: "UTF-8" };
  const simple: Record<string, unknown> = {
    Subject: { Data: message.subject, Charset: "UTF-8" },
    Body: body,
  };
  const headers = Object.entries(message.headers ?? {});
  if (headers.length > 0) simple.Headers = headers.map(([Name, Value]) => ({ Name, Value }));
  if (message.attachments?.length) {
    simple.Attachments = message.attachments.map((item) => {
      const out: Record<string, string> = {
        FileName: item.filename,
        RawContent: typeof item.content === "string" ? item.content : bytesToBase64(item.content),
        ContentType: item.contentType,
        ContentTransferEncoding: "BASE64",
        ContentDisposition: item.contentId === undefined ? "ATTACHMENT" : "INLINE",
      };
      if (item.contentId !== undefined) out.ContentId = item.contentId;
      return out;
    });
  }
  const payload: Record<string, unknown> = {
    FromEmailAddress: encodeMailbox(message.from),
    Destination: destination,
    Content: { Simple: simple },
  };
  if (message.replyTo !== undefined) payload.ReplyToAddresses = [encodeMailbox(message.replyTo)];
  if (configurationSetName !== undefined) payload.ConfigurationSetName = configurationSetName;
  return payload;
}

function checkOptions(options: SesOptions): string | null {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("ses expects an options object.");
  }
  if (options.endpoint === undefined) return null;
  if (!/^https?:$/.test(URL.parse(options.endpoint)?.protocol ?? "")) {
    throw new TypeError("ses: endpoint must be an absolute http or https URL.");
  }
  return options.endpoint.replace(/\/+$/, "");
}

/** The SES API origin of a region. */
export function sesEndpoint(region: string): string {
  return `https://email.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
}

/**
 * Creates the Amazon SES adapter. The webhook methods verify SNS messages. The
 * `secret` of `handleWebhook` is the topic allowlist: one or more topic ARNs, separated
 * by commas. Create the adapter once per isolate, so its certificate cache is reused.
 *
 * @throws TypeError for an invalid option.
 */
export function ses(options: SesOptions = {}): ProviderAdapter {
  const endpoint = checkOptions(options);
  const verifySns = createSnsVerifier(options);

  /** One signed SES call: a GET without a body, or a POST of JSON. */
  async function call(ctx: SendContext, path: string, body?: string): Promise<ProviderCall> {
    const value = (name: "region" | "accessKeyId" | "secretAccessKey" | "sessionToken") =>
      ctx.credentials[name] || options[name] || "";
    const region = value("region");
    const url = `${endpoint ?? sesEndpoint(region)}${path}`;
    const request: SigV4Request & { method: string } =
      body === undefined
        ? { method: "GET", url }
        : { method: "POST", url, headers: { "content-type": "application/json" }, body };
    const credentials: SigV4Credentials = {
      accessKeyId: value("accessKeyId"),
      secretAccessKey: value("secretAccessKey"),
      // An empty token is not signed or sent.
      sessionToken: value("sessionToken"),
    };
    const headers = await signRequest(request, credentials, { region, service: "ses" }, ctx.now);
    return callProvider({ ...request, headers, timeoutMs: ctx.timeoutMs, fetch: ctx.fetch });
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, sesMeta.capabilities);
    if (!checked.ok) return tag(checked.result);
    if (Object.keys(message.headers ?? {}).length > SES_MAX_HEADERS) {
      return tag({
        status: "not_sent",
        reason: "unsupported",
        message: "SES takes at most 15 custom headers.",
      });
    }
    const body = JSON.stringify(sesPayload(message, options.configurationSetName));
    const sent = await call(ctx, "/v2/email/outbound-emails", body);
    if (!sent.ok) return tag(sent.result);
    const failed = await failure(sent.response, ctx);
    if (failed) return failed;
    const id = ((await readJson(sent.response)) as { MessageId?: unknown } | null)?.MessageId;
    return {
      status: "sent",
      provider: PROVIDER,
      ...(typeof id === "string" ? { providerMessageId: id } : {}),
    };
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    // GetAccount is authenticated and sends no email.
    const checked = await call(ctx, "/v2/email/account");
    if (!checked.ok) return { ...tag(checked.result), ok: false };
    const failed = await failure(checked.response, ctx);
    if (failed) return { ...failed, ok: false };
    await discardBody(checked.response);
    return { ok: true };
  }

  return defineProvider({
    meta: sesMeta,
    send,
    verify,
    webhooks: { verify: verifySns, parse: parseSesEvents, signedTimestamp: true },
  });
}
