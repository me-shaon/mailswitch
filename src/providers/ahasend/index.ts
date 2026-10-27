// mailswitch/ahasend: the AhaSend adapter. It sends one message with
// `POST /v2/accounts/{account_id}/messages/conversation`, which takes cc and bcc and does
// no template rendering. It checks the key with `GET /v2/ping`. AhaSend keeps an
// `Idempotency-Key` for 24 hours. Checked 2026-10-27.
// https://ahasend.com/docs/api-reference/messages/create-conversation.md
// https://ahasend.com/docs/api-reference/authentication.md
// https://ahasend.com/docs/api-reference/errors.md
// https://ahasend.com/docs/api-reference/idempotency.md
// https://ahasend.com/docs/api-reference/utility/ping.md

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { validateMessage } from "../../core/message";
import type { NotSentResult, OutgoingMessage, SendResult, UnknownResult } from "../../core/types";
import { bytesToHex, utf8 } from "../../internal/encoding";
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
import { ahasendMeta } from "./meta";
import { ahasendPayload, messageProblem, recipientCount } from "./payload";
import { ahasendWebhooks } from "./webhooks";

export { ahasendMeta } from "./meta";
export { AHASEND_MAX_LIST_RECIPIENTS } from "./payload";
export {
  AHASEND_ID_HEADER,
  AHASEND_SIGNATURE_HEADER,
  AHASEND_TIMESTAMP_HEADER,
  AHASEND_WEBHOOK_TOLERANCE_MS,
  ahasendSignedPayload,
  ahasendWebhooks,
  parseAhasendEvents,
  verifyAhasendWebhook,
} from "./webhooks";

/** The AhaSend API origin. */
export const AHASEND_API_BASE = "https://api.ahasend.com";
/** The longest `Idempotency-Key` that AhaSend accepts. A longer key goes out as its SHA-256 hex. */
export const AHASEND_MAX_KEY_LENGTH = 255;

/** Options of `ahasend`. */
export interface AhasendOptions {
  /** The API key. The `apiKey` credential in the send context takes precedence. */
  apiKey?: string;
  /** The account id. The `accountId` credential in the send context takes precedence. */
  accountId?: string;
  /** The API origin. Defaults to `AHASEND_API_BASE`. Tests and proxies change it. */
  baseUrl?: string;
  /**
   * Sends with `sandbox: true`. AhaSend checks the request, answers as for a real send,
   * and delivers no email. For tests only.
   */
  sandbox?: boolean;
}

/** The AhaSend adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface AhasendAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = ahasendMeta.id;
// Printable ASCII only. Any other key goes out hashed, because a header carries bytes.
const PLAIN_KEY = /^[\x20-\x7e]+$/;
const ACCOUNT_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The `Idempotency-Key` value for a message key. A printable ASCII key of at most 255
 * characters goes out as it is. Any other key goes out as the SHA-256 hex of its UTF-8
 * bytes, so two long keys with a shared prefix never collide.
 */
export async function ahasendIdempotencyKey(key: string): Promise<string> {
  if (key.length <= AHASEND_MAX_KEY_LENGTH && PLAIN_KEY.test(key)) return key;
  return bytesToHex(await crypto.subtle.digest("SHA-256", utf8(key)));
}

function unreadable(): UnknownResult {
  return {
    status: "unknown",
    reason: "provider_error",
    message: "AhaSend accepted the request with an answer that mailswitch cannot read.",
    provider: PROVIDER,
  };
}

/**
 * Reads an accepted answer. `data` holds one entry for each recipient.
 *
 * - The first entry with `status` `queued` or `scheduled` gives `sent` with its `id`, at
 *   any index.
 * - Every entry `error`, with one entry for each to, cc, and bcc recipient, gives
 *   `not_sent/rejected`. No recipient got the message.
 * - Any other shape is `unknown`: an empty list, fewer or more entries than recipients,
 *   an entry with a missing or other status, and a body that cannot be read.
 */
function accepted(body: unknown, recipients: number): SendResult {
  const list = asRecord(body)?.data;
  if (!Array.isArray(list) || list.length === 0) return unreadable();
  let errors = 0;
  for (const item of list) {
    const entry = asRecord(item);
    const status = entry?.status;
    if (entry !== undefined && (status === "queued" || status === "scheduled")) {
      const id = stringField(entry, "id");
      return { status: "sent", provider: PROVIDER, ...(id ? { providerMessageId: id } : {}) };
    }
    if (status === "error") errors += 1;
  }
  if (errors === list.length && list.length === recipients) {
    return {
      status: "not_sent",
      reason: "rejected",
      message: "AhaSend refused every recipient of the message.",
      provider: PROVIDER,
    };
  }
  return unreadable();
}

function refused(message: string, reason: NotSentResult["reason"]): NotSentResult {
  return { status: "not_sent", reason, message, provider: PROVIDER };
}

function checkOptions(options: AhasendOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("ahasend expects an options object.");
  }
  for (const name of ["apiKey", "accountId"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "string") {
      throw new TypeError(`ahasend: ${name} must be a string.`);
    }
  }
  if (options.sandbox !== undefined && typeof options.sandbox !== "boolean") {
    throw new TypeError("ahasend: sandbox must be a boolean.");
  }
  return parseBaseUrl(options.baseUrl, AHASEND_API_BASE, "ahasend: baseUrl");
}

/**
 * Creates the AhaSend adapter.
 *
 * @throws TypeError for invalid options.
 */
export function ahasend(options: AhasendOptions = {}): AhasendAdapter {
  const base = checkOptions(options);
  const sandbox = options.sandbox === true;
  const webhooks = ahasendWebhooks(PROVIDER);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${ctx.credentials.apiKey || options.apiKey || ""}`,
      "content-type": "application/json",
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, ahasendMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const problem = messageProblem(message);
    if (problem !== null) return refused(problem, "invalid_message");
    const account = ctx.credentials.accountId || options.accountId || "";
    if (!ACCOUNT_ID.test(account)) {
      return refused("The AhaSend account id is missing or not valid.", "auth");
    }
    const head = headers(ctx);
    if (message.idempotencyKey !== undefined) {
      head["idempotency-key"] = await ahasendIdempotencyKey(message.idempotencyKey);
    }
    const call = await callProvider({
      url: `${base}/v2/accounts/${account}/messages/conversation`,
      headers: head,
      body: JSON.stringify(ahasendPayload(message, sandbox)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) {
      await discardBody(response);
      return classifyFailure(response, ahasendMeta.statusMap, ctx.now, PROVIDER);
    }
    return accepted(await readJson(response), recipientCount(message));
  }

  function verify(ctx: SendContext): Promise<VerifyResult> {
    // Ping is authenticated and sends no email.
    return verifyByGet(
      { url: `${base}/v2/ping`, headers: headers(ctx), timeoutMs: ctx.timeoutMs, fetch: ctx.fetch },
      PROVIDER,
      ahasendMeta.statusMap,
      ctx.now,
    );
  }

  const adapter = defineProvider({ meta: ahasendMeta, send, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
