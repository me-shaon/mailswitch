// mailswitch/mailtrap: the Mailtrap adapter. It sends one message with `POST /api/send`
// on the transactional or the bulk stream host, or with `POST /api/send/{inbox_id}` on the
// sandbox host. It checks the token with `GET https://mailtrap.io/api/accounts`. The token
// goes in the `Api-Token` header. Mailtrap has no idempotency key, so the mailer store
// gives the only duplicate protection. Checked 2026-10-27.
// https://docs.mailtrap.io/developers/email-sending/transactional/send-transactional-email.md
// https://docs.mailtrap.io/developers/authentication.md
// https://docs.mailtrap.io/email-api-smtp/setup/sending-limits.md
//
// A 200 with `success: true` and a `message_ids` list is `sent` with the first id. Any
// other 2xx body is `unknown`. Errors use the default table, and every 5xx is `unknown`.
// The Mailtrap edge blocks a request with no `User-Agent`, so every request sends one.

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderWebhooks,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { validateMessage } from "../../core/message";
import type { OutgoingMessage, SendResult } from "../../core/types";
import {
  callProvider,
  classifyFailure,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import { asRecord } from "../../internal/json";
import { mailtrapMeta } from "./meta";
import { mailtrapPayload } from "./payload";
import { mailtrapWebhooks } from "./webhooks";

export { mailtrapMeta } from "./meta";
export {
  MAILTRAP_SIGNATURE_HEADER,
  mailtrapSignature,
  mailtrapWebhooks,
  parseMailtrapEvents,
  verifyMailtrapWebhook,
} from "./webhooks";

/** The send origin of each Mailtrap stream, and of the sandbox. */
export const MAILTRAP_HOSTS: Readonly<{ transactional: string; bulk: string; sandbox: string }> =
  Object.freeze({
    transactional: "https://send.api.mailtrap.io",
    bulk: "https://bulk.api.mailtrap.io",
    sandbox: "https://sandbox.api.mailtrap.io",
  });

/** The origin of the account API, which verify calls. */
export const MAILTRAP_ACCOUNTS_BASE = "https://mailtrap.io";

/** The `User-Agent` of every request. */
export const MAILTRAP_USER_AGENT = "mailswitch";

/** A Mailtrap sending stream. */
export type MailtrapStream = "transactional" | "bulk";

/** Options of `mailtrap`. */
export interface MailtrapOptions {
  /** The API token. The `apiKey` credential in the send context takes precedence. */
  apiKey?: string;
  /** The sending stream. Defaults to `transactional`. */
  stream?: MailtrapStream;
  /**
   * The id of a sandbox inbox, as digits. When it is set, every send goes to that inbox on
   * the sandbox host, and Mailtrap delivers no email. It cannot be used with the bulk stream.
   */
  sandboxInboxId?: string;
  /** The send origin, for tests or a proxy. It replaces the stream or sandbox origin. */
  baseUrl?: string;
  /** The account API origin, for tests or a proxy. Defaults to `MAILTRAP_ACCOUNTS_BASE`. */
  accountsUrl?: string;
}

/** The Mailtrap adapter. Its webhooks need a dedupe store, as `requiresDedupe` marks. */
export interface MailtrapAdapter extends ProviderAdapter {
  webhooks: ProviderWebhooks;
  readonly requiresDedupe: true;
}

const PROVIDER = mailtrapMeta.id;
const INBOX_ID = /^\d{1,20}$/;

/** Reads a 2xx send answer. Only `success: true` with a string first id is `sent`. */
function accepted(json: unknown, httpStatus: number): SendResult {
  const body = asRecord(json);
  const ids = body?.message_ids;
  const id = Array.isArray(ids) ? ids[0] : undefined;
  if (body?.success === true && typeof id === "string" && id !== "") {
    return { status: "sent", provider: PROVIDER, providerMessageId: id };
  }
  return {
    status: "unknown",
    reason: "provider_error",
    message: "Mailtrap accepted the request with an answer that mailswitch cannot read.",
    httpStatus,
    provider: PROVIDER,
  };
}

function checkOptions(options: MailtrapOptions): { send: string; accounts: string } {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("mailtrap expects an options object.");
  }
  if (options.apiKey !== undefined && typeof options.apiKey !== "string") {
    throw new TypeError("mailtrap: apiKey must be a string.");
  }
  const stream = options.stream ?? "transactional";
  if (stream !== "transactional" && stream !== "bulk") {
    throw new TypeError('mailtrap: stream must be "transactional" or "bulk".');
  }
  const inbox = options.sandboxInboxId;
  if (inbox !== undefined && (typeof inbox !== "string" || !INBOX_ID.test(inbox))) {
    throw new TypeError("mailtrap: sandboxInboxId must be a string of digits.");
  }
  if (inbox !== undefined && stream === "bulk") {
    throw new TypeError("mailtrap: sandboxInboxId cannot be used with the bulk stream.");
  }
  const origin = parseBaseUrl(
    options.baseUrl,
    inbox === undefined ? MAILTRAP_HOSTS[stream] : MAILTRAP_HOSTS.sandbox,
    "mailtrap: baseUrl",
  );
  return {
    send: inbox === undefined ? `${origin}/api/send` : `${origin}/api/send/${inbox}`,
    accounts: parseBaseUrl(options.accountsUrl, MAILTRAP_ACCOUNTS_BASE, "mailtrap: accountsUrl"),
  };
}

/**
 * Creates the Mailtrap adapter.
 *
 * @throws TypeError for invalid options.
 */
export function mailtrap(options: MailtrapOptions = {}): MailtrapAdapter {
  const urls = checkOptions(options);
  const webhooks = mailtrapWebhooks(PROVIDER);

  function headers(ctx: SendContext): Record<string, string> {
    return {
      accept: "application/json",
      "api-token": ctx.credentials.apiKey || options.apiKey || "",
      "content-type": "application/json",
      "user-agent": MAILTRAP_USER_AGENT,
    };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, mailtrapMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const call = await callProvider({
      url: urls.send,
      headers: headers(ctx),
      body: JSON.stringify(mailtrapPayload(message)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) {
      await discardBody(response);
      return classifyFailure(response, mailtrapMeta.statusMap, ctx.now, PROVIDER);
    }
    return accepted(await readJson(response), response.status);
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    // The account list is an authenticated read on its own host. It sends no email.
    const call = await callProvider({
      url: `${urls.accounts}/api/accounts`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...withProvider(call.result, PROVIDER), ok: false };
    await discardBody(call.response);
    if (call.response.ok) return { ok: true };
    return {
      ...classifyFailure(call.response, mailtrapMeta.statusMap, ctx.now, PROVIDER),
      ok: false,
    };
  }

  const adapter = defineProvider({ meta: mailtrapMeta, send, verify, webhooks });
  return { ...adapter, webhooks, requiresDedupe: true };
}
