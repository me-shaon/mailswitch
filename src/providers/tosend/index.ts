// mailswitch/tosend: the toSend adapter. It sends one message with `POST /v2/emails`, a
// batch with `POST /v2/emails/batch`, and checks the key with `GET /v2/info`. toSend has
// no idempotency key, so the mailer store gives the only duplicate protection.
// https://tosend.com/docs/api/send-email/
// https://tosend.com/docs/api/batch-emails/

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
import { toSendMeta } from "./meta";
import { toSendPayload } from "./payload";
import { toSendWebhooks } from "./webhooks";

export { toSendMeta } from "./meta";
export { TOSEND_SIGNATURE_HEADER, toSendSignature } from "./webhooks";

/** The default base URL of the toSend API. */
export const TOSEND_API_BASE = "https://api.tosend.com";

/** Options of `tosend`. */
export interface ToSendOptions {
  /**
   * The API key. The `apiKey` credential in the send context takes precedence, so a
   * mailer that stores credentials can omit it here.
   */
  apiKey?: string;
  /** The API base URL, for tests or a proxy. Defaults to `TOSEND_API_BASE`. */
  baseUrl?: string;
}

/** The toSend adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface ToSendAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

/**
 * Classifies a failed response. A 403 means a wrong key or no credits, and only the body
 * text tells them apart. The body is read but never copied into the result.
 */
async function failure(response: Response, now: number): Promise<NotSentResult | UnknownResult> {
  const outcome = classifyResponse(response.status, response.headers, toSendMeta.statusMap, {
    now,
  }) as NotSentResult | UnknownResult;
  if (response.status !== 403 || outcome.status !== "not_sent") {
    await discardBody(response);
    return withProvider(outcome, toSendMeta.id);
  }
  const body = (await readJson(response)) as { message?: unknown } | null;
  const text = typeof body?.message === "string" ? body.message : "";
  if (!/credit/i.test(text)) return withProvider(outcome, toSendMeta.id);
  return withProvider(
    {
      ...outcome,
      reason: "credits",
      message: "The provider answered with HTTP 403 (credits).",
    },
    toSendMeta.id,
  );
}

/** Creates the toSend adapter. Throws a TypeError for invalid options. */
export function tosend(options: ToSendOptions = {}): ToSendAdapter {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("tosend expects an options object.");
  }
  const base = parseBaseUrl(options.baseUrl, TOSEND_API_BASE, "tosend: baseUrl");

  function headers(ctx: SendContext): Record<string, string> {
    const key = ctx.credentials.apiKey || options.apiKey || "";
    return {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    };
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
    const checked = validateMessage(message, toSendMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, toSendMeta.id);
    const call = await post("/v2/emails", toSendPayload(message), ctx);
    if (!call.ok) return withProvider(call.result, toSendMeta.id);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now);
    const json = (await readJson(response)) as { message_id?: unknown } | null;
    const id = json?.message_id;
    return {
      status: "sent",
      provider: toSendMeta.id,
      ...(typeof id === "string" && id !== "" ? { providerMessageId: id } : {}),
    };
  }

  async function sendBatch(
    messages: readonly OutgoingMessage[],
    ctx: SendContext,
  ): Promise<SendResult[]> {
    if (messages.length > toSendMeta.capabilities.batchSize) {
      throw new RangeError(
        `toSend takes at most ${toSendMeta.capabilities.batchSize} messages per batch.`,
      );
    }
    const results: (SendResult | undefined)[] = messages.map((message) => {
      const checked = validateMessage(message, toSendMeta.capabilities);
      return checked.ok ? undefined : withProvider(checked.result, toSendMeta.id);
    });
    const slots = results.flatMap((result, index) => (result === undefined ? [index] : []));
    if (slots.length === 0) return results as SendResult[];
    const emails = slots.map((index) => toSendPayload(messages[index] as OutgoingMessage));
    const call = await post("/v2/emails/batch", { emails }, ctx);
    let fill: (position: number) => SendResult;
    if (!call.ok) {
      const result = withProvider(call.result, toSendMeta.id);
      fill = () => result;
    } else if (!call.response.ok) {
      const result = await failure(call.response, ctx.now);
      fill = () => result;
    } else {
      const json = (await readJson(call.response)) as { results?: unknown } | null;
      const items = Array.isArray(json?.results) ? (json.results as unknown[]) : [];
      fill = (position) => batchItem(items[position]);
    }
    slots.forEach((index, position) => {
      results[index] = fill(position);
    });
    return results as SendResult[];
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const call = await callProvider({
      url: `${base}/v2/info`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...withProvider(call.result, toSendMeta.id), ok: false };
    if (!call.response.ok) return { ...(await failure(call.response, ctx.now)), ok: false };
    await discardBody(call.response);
    return { ok: true };
  }

  const adapter = defineProvider({
    meta: toSendMeta,
    send,
    sendBatch,
    verify,
    webhooks: toSendWebhooks(toSendMeta.id),
  });
  return { ...adapter, webhooks: adapter.webhooks as ProviderWebhooks, requiresDedupe: true };
}

/** Maps one entry of a 200 or 207 batch response. A missing entry is `unknown`. */
function batchItem(item: unknown): SendResult {
  const entry = (typeof item === "object" && item !== null ? item : {}) as {
    status?: unknown;
    message_id?: unknown;
    status_code?: unknown;
  };
  const code = typeof entry.status_code === "number" ? entry.status_code : 0;
  if (entry.status === "success") {
    return {
      status: "sent",
      provider: toSendMeta.id,
      ...(typeof entry.message_id === "string" && entry.message_id !== ""
        ? { providerMessageId: entry.message_id }
        : {}),
    };
  }
  if (entry.status === "spam") {
    return withProvider(
      {
        status: "not_sent",
        reason: "rejected",
        message: "toSend refused this email as spam.",
      },
      toSendMeta.id,
    );
  }
  // An error entry is a 4xx refusal. An entry with a 5xx code may still go out.
  if (entry.status === "error" && code < 500) {
    return withProvider(
      {
        status: "not_sent",
        reason: "invalid_message",
        message: "toSend refused this email as invalid.",
      },
      toSendMeta.id,
    );
  }
  return withProvider(
    {
      status: "unknown",
      reason: "provider_error",
      message: "toSend returned no clear result for this email.",
    },
    toSendMeta.id,
  );
}
