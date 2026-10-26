// mailswitch/postmark: the Postmark adapter. It sends one message with `POST /email`, a
// batch with `POST /email/batch`, and checks the token with `GET /server`. Postmark has
// no idempotency key, so the mailer store gives the only duplicate protection.
// https://postmarkapp.com/developer/api/email-api
// https://postmarkapp.com/developer/api/server-api
// https://postmarkapp.com/developer/api/overview

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
import {
  callProvider,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import { postmarkMeta } from "./meta";
import { postmarkPayload } from "./payload";
import { type PostmarkWebhookOptions, postmarkWebhooks } from "./webhooks";

export { postmarkMeta } from "./meta";
export {
  checkPostmarkWebhookSecret,
  generatePostmarkWebhookSecret,
  POSTMARK_MIN_HEX_SECRET_LENGTH,
  POSTMARK_MIN_SECRET_LENGTH,
  POSTMARK_WEBHOOK_USERNAME,
  type PostmarkWebhookOptions,
  parsePostmarkEvents,
  postmarkWebhookAuthorization,
  postmarkWebhooks,
} from "./webhooks";

/** The Postmark API origin. */
export const POSTMARK_API_BASE = "https://api.postmarkapp.com";

/** Options of `postmark`. */
export interface PostmarkOptions {
  /**
   * The server API token. The `serverToken` credential in the send context takes
   * precedence, so a mailer that stores credentials can omit it here.
   */
  serverToken?: string;
  /**
   * The message stream ID. The `messageStream` credential takes precedence. When both are
   * empty, Postmark uses the default transactional stream, `outbound`.
   */
  messageStream?: string;
  /** The API origin, for tests or a proxy. Defaults to `POSTMARK_API_BASE`. */
  baseUrl?: string;
  /** The Basic auth username of the webhook. Defaults to `POSTMARK_WEBHOOK_USERNAME`. */
  webhookUsername?: string;
  /**
   * The webhook secret before a rotation. While it is set, both the current secret (the
   * `secret` of `handleWebhook`) and this one pass.
   */
  previousWebhookSecret?: string;
}

/** The Postmark adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface PostmarkAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = postmarkMeta.id;

interface PostmarkError {
  ErrorCode?: unknown;
  Message?: unknown;
}

/**
 * The reason of a Postmark ErrorCode, when it is more exact than the HTTP status.
 * Source: https://postmarkapp.com/developer/api/overview#error-codes
 * - 10: the token is not valid. 413: the account is not approved to send. 1480: the IP
 *   address is not allowed to send. All three are `auth`.
 * - 406: the recipient is inactive (suppressed). 412: while the account waits for
 *   approval, every recipient must share the domain of the From address. Both are
 *   `rejected`.
 */
function reasonOf(code: unknown): FailureReason | null {
  switch (code) {
    case 10:
    case 413:
    case 1480:
      return "auth";
    case 406:
    case 412:
      return "rejected";
    default:
      return null;
  }
}

/** Refines the reason of a `not_sent` result. It never copies the response body. */
function refine(result: NotSentResult, error: PostmarkError | null): NotSentResult {
  const reason = reasonOf(error?.ErrorCode);
  if (reason === null || reason === result.reason) return result;
  return {
    ...result,
    reason,
    message: `The provider answered with HTTP ${result.httpStatus} (${reason}).`,
  };
}

/** Classifies a failed response. Reads the body only to refine a `not_sent` reason. */
async function failure(response: Response, now: number): Promise<NotSentResult | UnknownResult> {
  const outcome = classifyResponse(response.status, response.headers, postmarkMeta.statusMap, {
    now,
  }) as NotSentResult | UnknownResult;
  if (outcome.status === "unknown") {
    await discardBody(response);
    return withProvider(outcome, PROVIDER);
  }
  return withProvider(
    refine(outcome, (await readJson(response)) as PostmarkError | null),
    PROVIDER,
  );
}

/**
 * Maps one entry of a batch response. Postmark answers a batch with 200 and one entry
 * per message, in order. An entry with ErrorCode 0 was accepted. ErrorCode 100 (offline
 * for maintenance) and 101 (unexpected error) are server faults, so they are `unknown`.
 * A missing entry is `unknown`.
 */
function batchItem(item: unknown): SendResult {
  const entry = (typeof item === "object" && item !== null ? item : {}) as PostmarkError & {
    MessageID?: unknown;
  };
  const code = entry.ErrorCode;
  if (code === 0) {
    return {
      status: "sent",
      provider: PROVIDER,
      ...(typeof entry.MessageID === "string" && entry.MessageID !== ""
        ? { providerMessageId: entry.MessageID }
        : {}),
    };
  }
  if (typeof code !== "number" || code === 100 || code === 101) {
    return withProvider(
      {
        status: "unknown",
        reason: "provider_error",
        message: "Postmark returned no clear result for this email.",
      },
      PROVIDER,
    );
  }
  const reason = reasonOf(code) ?? "invalid_message";
  return withProvider(
    {
      status: "not_sent",
      reason,
      message: `Postmark refused this email (${reason}).`,
    },
    PROVIDER,
  );
}

function checkOptions(options: PostmarkOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("postmark expects an options object.");
  }
  return parseBaseUrl(options.baseUrl, POSTMARK_API_BASE, "postmark: baseUrl");
}

/**
 * Creates the Postmark adapter.
 *
 * @throws TypeError for invalid options, an invalid webhook username, or a
 * `previousWebhookSecret` with less than 128 bits.
 */
export function postmark(options: PostmarkOptions = {}): PostmarkAdapter {
  const base = checkOptions(options);
  const hookOptions: PostmarkWebhookOptions = {};
  if (options.webhookUsername !== undefined) hookOptions.username = options.webhookUsername;
  if (options.previousWebhookSecret !== undefined) {
    hookOptions.previousSecret = options.previousWebhookSecret;
  }
  const webhooks = postmarkWebhooks(PROVIDER, hookOptions);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "x-postmark-server-token": ctx.credentials.serverToken || options.serverToken || "",
    };
  }

  function stream(ctx: SendContext): string | undefined {
    return ctx.credentials.messageStream || options.messageStream || undefined;
  }

  async function post(path: string, body: unknown, ctx: SendContext) {
    return callProvider({
      url: `${base}${path}`,
      headers: headers(ctx),
      body: JSON.stringify(body),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, postmarkMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const call = await post("/email", postmarkPayload(message, stream(ctx)), ctx);
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now);
    const id = ((await readJson(response)) as { MessageID?: unknown } | null)?.MessageID;
    return {
      status: "sent",
      provider: PROVIDER,
      ...(typeof id === "string" && id !== "" ? { providerMessageId: id } : {}),
    };
  }

  async function sendBatch(
    messages: readonly OutgoingMessage[],
    ctx: SendContext,
  ): Promise<SendResult[]> {
    if (messages.length > postmarkMeta.capabilities.batchSize) {
      throw new RangeError(
        `Postmark takes at most ${postmarkMeta.capabilities.batchSize} messages per batch.`,
      );
    }
    const results: (SendResult | undefined)[] = messages.map((message) => {
      const checked = validateMessage(message, postmarkMeta.capabilities);
      return checked.ok ? undefined : withProvider(checked.result, PROVIDER);
    });
    const slots = results.flatMap((result, index) => (result === undefined ? [index] : []));
    if (slots.length === 0) return results as SendResult[];
    const target = stream(ctx);
    const emails = slots.map((index) =>
      postmarkPayload(messages[index] as OutgoingMessage, target),
    );
    const call = await post("/email/batch", emails, ctx);
    let fill: (position: number) => SendResult;
    if (!call.ok) {
      const result = withProvider(call.result, PROVIDER);
      fill = () => result;
    } else if (!call.response.ok) {
      const result = await failure(call.response, ctx.now);
      fill = () => result;
    } else {
      const json = await readJson(call.response);
      const items = Array.isArray(json) ? (json as unknown[]) : [];
      fill = (position) => batchItem(items[position]);
    }
    slots.forEach((index, position) => {
      results[index] = fill(position);
    });
    return results as SendResult[];
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const call = await callProvider({
      url: `${base}/server`,
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

  const adapter = defineProvider({ meta: postmarkMeta, send, sendBatch, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
