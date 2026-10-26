// The conformance fixtures of the Cloudflare Email adapter. There was no test account, so
// the REST responses copy the examples and the error table of the API reference. Recorded
// 2026-10-26.
// https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
// https://developers.cloudflare.com/api/resources/email_sending/methods/send/
//
// The binding transport makes no HTTP call. `cloudflareBindingBridge` gives it a fake
// binding that turns each `send` into one request to `ctx.fetch`, so the kit can replay
// binding outcomes from recorded exchanges. A recorded `{ code }` body becomes a thrown
// error with that code, as the binding throws it.
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/

import type { ProviderAdapter, SendContext, VerifyResult } from "../../core/adapter";
import type { OutgoingMessage, SendResult } from "../../core/types";
import { bytesToBase64 } from "../../internal/encoding";
import { callProvider, readJson } from "../../internal/http";
import {
  type CloudflareEmailBuilder,
  type CloudflareSendEmail,
  cloudflareBinding,
} from "../../providers/cloudflare/index";
import type { ConformanceFixture } from "../types";

const API = "https://api.cloudflare.com/client/v4";
/** A made-up account ID. */
export const CLOUDFLARE_FIXTURE_ACCOUNT = "0123456789abcdef0123456789abcdef";
/** A made-up message ID. */
export const CLOUDFLARE_FIXTURE_MESSAGE_ID = "0f6f9f3e-2b7a-4c1d-9e8f-5a4b3c2d1e0f";
const SEND_URL = `${API}/accounts/${CLOUDFLARE_FIXTURE_ACCOUNT}/email/sending/send`;
const NOW = Date.parse("2026-10-26T12:00:00.000Z");

function restError(code: number, message: string): Record<string, unknown> {
  return { success: false, errors: [{ code, message }], messages: [], result: null };
}

/** The fixture that drives `cloudflareRest()` through every conformance check. */
export function cloudflareRestFixture(): ConformanceFixture {
  const accepted = {
    status: 200,
    body: {
      success: true,
      errors: [],
      messages: [],
      result: {
        delivered: ["recipient@example.org"],
        permanent_bounces: [],
        queued: [],
        message_id: CLOUDFLARE_FIXTURE_MESSAGE_ID,
      },
    },
  };
  return {
    credentials: { accountId: CLOUDFLARE_FIXTURE_ACCOUNT, apiToken: "cf_test_token_0123456789" },
    now: NOW,
    send: {
      request: { method: "POST", url: SEND_URL },
      success: accepted,
      providerMessageId: CLOUDFLARE_FIXTURE_MESSAGE_ID,
      authFailure: {
        status: 401,
        body: restError(10101, "email.sending.error.authentication.unauthorized"),
      },
      validationFailure: {
        status: 400,
        body: restError(10001, "email.sending.error.invalid_request_schema"),
      },
      serverError: { status: 500, body: restError(10002, "email.sending.error.internal_server") },
      rateLimited: {
        status: 429,
        headers: { "retry-after": "1" },
        body: restError(10004, "email.sending.error.throttled"),
      },
      batch: { request: { method: "POST", url: SEND_URL }, success: accepted },
    },
    readHeaders: (request) =>
      (JSON.parse(request.body) as { headers?: Record<string, string> }).headers ?? {},
    readAttachments: (request) =>
      (
        (JSON.parse(request.body) as { attachments?: { filename: string; content: string }[] })
          .attachments ?? []
      ).map((item) => ({ filename: item.filename, content: item.content })),
    verify: {
      ok: [
        {
          label: "verify an account token",
          method: "GET",
          url: `${API}/accounts/${CLOUDFLARE_FIXTURE_ACCOUNT}/tokens/verify`,
          response: {
            status: 200,
            body: {
              success: true,
              errors: [],
              messages: [],
              result: { id: "ed17574386854bf78a67040be0a770b0", status: "active" },
            },
          },
        },
      ],
      badKey: [
        {
          label: "verify a wrong token under the account",
          method: "GET",
          url: `${API}/accounts/${CLOUDFLARE_FIXTURE_ACCOUNT}/tokens/verify`,
          response: { status: 401, body: restError(1000, "Invalid API Token") },
        },
        {
          label: "verify a wrong token under the user",
          method: "GET",
          url: `${API}/user/tokens/verify`,
          response: { status: 401, body: restError(1000, "Invalid API Token") },
        },
      ],
    },
    // The account ID must contain the canary token and keep 32 characters.
    canary: (field, token) => (field.name === "accountId" ? token.padEnd(32, "0") : `cf_${token}`),
  };
}

/** The URL of the binding bridge. It is not a real endpoint. */
export const CLOUDFLARE_BINDING_BRIDGE_URL = "https://send-email-binding.invalid";

/** A binding whose outcomes come from `ctx.fetch`, and the adapter that uses it. */
export interface CloudflareBindingBridge {
  /** The fake binding. Each `send` posts its message as JSON to the bridge URL. */
  binding: CloudflareSendEmail;
  /**
   * The binding adapter, wrapped so that each call routes the binding through
   * `ctx.fetch`. `verify` first asks the bridge whether the binding exists: a network
   * error or a 5xx is `unknown`, a 4xx removes the binding from `env`.
   */
  adapter: ProviderAdapter;
}

function jsonBuilder(message: CloudflareEmailBuilder): string {
  return JSON.stringify({
    ...message,
    attachments: message.attachments?.map((item) => ({
      ...item,
      content:
        typeof item.content === "string"
          ? item.content
          : bytesToBase64(
              item.content instanceof ArrayBuffer
                ? new Uint8Array(item.content)
                : new Uint8Array(
                    item.content.buffer,
                    item.content.byteOffset,
                    item.content.byteLength,
                  ),
            ),
    })),
  });
}

/** Builds a fake binding and an adapter for the conformance kit. */
export function cloudflareBindingBridge(): CloudflareBindingBridge {
  let current: SendContext["fetch"] | undefined;
  const binding: CloudflareSendEmail = {
    async send(message) {
      if (!current) throw new TypeError("The bridge has no fetch.");
      const response = await current(`${CLOUDFLARE_BINDING_BRIDGE_URL}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: jsonBuilder(message),
      });
      const body = (await readJson(response)) as { messageId?: unknown; code?: unknown } | null;
      if (response.ok) {
        return typeof body?.messageId === "string" ? { messageId: body.messageId } : undefined;
      }
      const error = new Error("The send_email binding refused the message.") as Error & {
        code?: string;
      };
      if (typeof body?.code === "string") error.code = body.code;
      else if (response.status >= 500) error.code = "E_INTERNAL_SERVER_ERROR";
      throw error;
    },
  };
  const env: Record<string, unknown> = { EMAIL: binding };
  const inner = cloudflareBinding({ env });

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    current = ctx.fetch;
    return inner.send(message, ctx);
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const call = await callProvider({
      url: `${CLOUDFLARE_BINDING_BRIDGE_URL}/binding`,
      method: "GET",
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...call.result, provider: inner.meta.id, ok: false };
    const status = call.response.status;
    await call.response.body?.cancel();
    if (status >= 500) {
      return {
        status: "unknown",
        reason: "provider_error",
        message: `The bridge answered with HTTP ${status}.`,
        provider: inner.meta.id,
        ok: false,
      };
    }
    if (status >= 400) delete env.EMAIL;
    else env.EMAIL = binding;
    try {
      return await inner.verify(ctx);
    } finally {
      env.EMAIL = binding;
    }
  }

  return { binding, adapter: { meta: inner.meta, send, verify } };
}

/** The fixture that drives the binding bridge through every conformance check. */
export function cloudflareBindingFixture(): ConformanceFixture {
  const send = { method: "POST", url: `${CLOUDFLARE_BINDING_BRIDGE_URL}/send` };
  const lookup = { method: "GET", url: `${CLOUDFLARE_BINDING_BRIDGE_URL}/binding` };
  return {
    credentials: { bindingName: "EMAIL" },
    now: NOW,
    send: {
      request: send,
      success: { status: 200, body: { messageId: CLOUDFLARE_FIXTURE_MESSAGE_ID } },
      providerMessageId: CLOUDFLARE_FIXTURE_MESSAGE_ID,
      authFailure: { status: 403, body: { code: "E_ACCOUNT_SUSPENDED" } },
      validationFailure: { status: 400, body: { code: "E_VALIDATION_ERROR" } },
      serverError: { status: 500, body: { code: "E_INTERNAL_SERVER_ERROR" } },
      // The binding error has no Retry-After value.
      rateLimited: { status: 429, body: { code: "E_RATE_LIMIT_EXCEEDED" } },
    },
    readHeaders: (request) =>
      (JSON.parse(request.body) as { headers?: Record<string, string> }).headers ?? {},
    readAttachments: (request) =>
      (
        (JSON.parse(request.body) as { attachments?: { filename: string; content: string }[] })
          .attachments ?? []
      ).map((item) => ({ filename: item.filename, content: item.content })),
    verify: {
      ok: [{ label: "the binding exists", ...lookup, response: { status: 200 } }],
      badKey: [{ label: "the binding is missing", ...lookup, response: { status: 404 } }],
    },
  };
}
