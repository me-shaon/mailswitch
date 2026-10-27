// The conformance fixture of the Resend adapter. The responses follow the Resend API
// reference: https://resend.com/docs/api-reference/introduction

import { base64ToBytes, bytesToBase64, hmacSign } from "../../provider-kit/index";
import { svixSignedPayload } from "../../providers/resend/webhooks";
import type { ConformanceFixture, WebhookSample } from "../types";

const API = "https://api.resend.com";
const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const MESSAGE_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
/** The `svix-id` of every signed sample. */
export const RESEND_FIXTURE_SVIX_ID = "msg_2Lh9KRb0pzN4lczuHvSw5cRtVnT";
/** A test signing secret: 24 bytes, base64, after `whsec_`. */
export const RESEND_FIXTURE_SECRET = "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX";

/** Signs a body the way Resend does, with Svix headers. */
export async function signResendWebhook(input: {
  body: Uint8Array;
  secret: string;
  at: number;
  id?: string;
}): Promise<WebhookSample> {
  const id = input.id ?? RESEND_FIXTURE_SVIX_ID;
  const timestamp = String(Math.floor(input.at / 1000));
  const key = base64ToBytes(input.secret.replace(/^whsec_/, "")) ?? new Uint8Array(0);
  const signature = bytesToBase64(
    await hmacSign(key, svixSignedPayload(id, timestamp, input.body)),
  );
  return {
    headers: new Headers({
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    }),
    body: input.body,
  };
}

/** A Resend webhook body. */
export function resendEvent(type: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    created_at: "2026-10-26T12:00:00.000Z",
    data: {
      email_id: MESSAGE_ID,
      from: "Acme <billing@example.com>",
      to: ["ana@example.org"],
      subject: "Invoice 42",
      created_at: "2026-10-26T11:59:00.000Z",
      ...data,
    },
  });
}

/** The fixture that drives `resend()` through every conformance check. */
export function resendFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: "re_test_0123456789" },
    now: NOW,
    send: {
      request: { method: "POST", url: `${API}/emails` },
      success: { status: 200, body: { id: MESSAGE_ID } },
      providerMessageId: MESSAGE_ID,
      authFailure: {
        status: 403,
        body: { statusCode: 403, name: "invalid_api_key", message: "API key is invalid" },
      },
      validationFailure: {
        status: 422,
        body: {
          statusCode: 422,
          name: "validation_error",
          message: "Invalid `from` field.",
        },
      },
      serverError: {
        status: 500,
        body: { statusCode: 500, name: "internal_server_error", message: "Unexpected error." },
      },
      rateLimited: {
        status: 429,
        headers: { "retry-after": "1" },
        body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." },
      },
      keyConflict: {
        status: 409,
        body: {
          statusCode: 409,
          name: "concurrent_idempotent_requests",
          message: "Same idempotency key used while original request is still in progress.",
        },
      },
      batch: {
        request: { method: "POST", url: `${API}/emails/batch` },
        success: {
          status: 200,
          body: { data: [{ id: MESSAGE_ID }, { id: "b1d9a2e4-7c0f-4f53-9d2e-1b6c4a8e9f00" }] },
        },
      },
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
          label: "list domains with a good key",
          method: "GET",
          url: `${API}/domains`,
          response: { status: 200, body: { object: "list", data: [] } },
        },
      ],
      badKey: [
        {
          label: "list domains with a wrong key",
          method: "GET",
          url: `${API}/domains`,
          response: {
            status: 403,
            body: { statusCode: 403, name: "invalid_api_key", message: "API key is invalid" },
          },
        },
      ],
    },
    webhook: {
      secret: RESEND_FIXTURE_SECRET,
      sign: (input) => signResendWebhook(input),
      staleAt: NOW - 10 * 60 * 1000,
      samples: [
        {
          label: "hard bounce",
          body: resendEvent("email.bounced", {
            bounce: { message: "Mailbox does not exist.", subType: "General", type: "Permanent" },
          }),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              bounceDetail: { text: "Mailbox does not exist." },
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              eventKey: RESEND_FIXTURE_SVIX_ID,
              rawType: "email.bounced",
              occurredAt: Date.parse("2026-10-26T12:00:00.000Z"),
            },
          ],
        },
        {
          label: "soft bounce",
          body: resendEvent("email.bounced", {
            bounce: { message: "Mailbox full.", subType: "MailboxFull", type: "Transient" },
          }),
          expected: [
            {
              type: "bounced",
              bounce: "soft",
              bounceDetail: { text: "Mailbox full." },
              eventKey: RESEND_FIXTURE_SVIX_ID,
            },
          ],
        },
        {
          label: "complaint",
          body: resendEvent("email.complained"),
          expected: [{ type: "complained", recipient: "ana@example.org" }],
        },
        {
          label: "delivery",
          body: resendEvent("email.delivered"),
          expected: [{ type: "delivered", providerMessageId: MESSAGE_ID }],
        },
        {
          label: "an event type that mailswitch does not map",
          body: resendEvent("email.opened"),
          expected: [{ type: "unknown", rawType: "email.opened" }],
        },
      ],
    },
  };
}
