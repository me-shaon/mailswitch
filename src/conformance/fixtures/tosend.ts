// The conformance fixture of the toSend adapter. The exchanges follow the shapes in
// https://tosend.com/docs (checked 2026-10-26). The ids are made up.

import { TOSEND_API_BASE, toSendSignature } from "../../providers/tosend/index";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const MESSAGE_ID = "0100019a-tosend-1";

/**
 * The webhook secret of the fixture. It protects nothing.
 * For tests only. Never use it in production config.
 */
export const TOSEND_FIXTURE_SECRET = "tosend-webhook-secret-0123456789";

/** Signs a body the way toSend does. toSend signs no time, so the helper ignores `at`. */
export async function signToSendWebhook(input: {
  body: Uint8Array;
  secret: string;
  at?: number;
}): Promise<WebhookSample> {
  return {
    headers: new Headers({
      "x-tosend-signature": await toSendSignature(input.secret, input.body),
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

/** The `reason` of the sample hard bounce. */
export const TOSEND_HARD_BOUNCE_REASON = "smtp; 550 5.1.1 The email account does not exist";

/** The `reason` of the sample soft bounce. */
export const TOSEND_SOFT_BOUNCE_REASON = "smtp; 452 4.2.2 The email account is over quota";

/** A toSend bounce body for one recipient. */
export function toSendBounce(
  email: string,
  hard: boolean = true,
  messageId: string = MESSAGE_ID,
): string {
  return JSON.stringify({
    type: "bounced",
    created_at: "2026-10-26T12:00:00.000Z",
    data: {
      email,
      bounce_type: hard ? "Permanent" : "Transient",
      bounce_sub_type: hard ? "General" : "MailboxFull",
      is_hard_bounce: hard,
      sender_fault: false,
      reason: hard ? TOSEND_HARD_BOUNCE_REASON : TOSEND_SOFT_BOUNCE_REASON,
      timestamp: "2026-10-26T11:59:58.000Z",
      message_id: messageId,
    },
  });
}

/** A toSend complaint body for one recipient. */
export function toSendComplaint(email: string, messageId: string = MESSAGE_ID): string {
  return JSON.stringify({
    type: "complaint",
    created_at: "2026-10-26T12:00:00.000Z",
    data: {
      email,
      feedback_type: "abuse",
      reason: "abuse",
      timestamp: "2026-10-26T11:59:58.000Z",
      message_id: messageId,
    },
  });
}

/** The fixture that drives `tosend()` through every conformance check. */
export function toSendFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: "tsend_test0123456789" },
    now: NOW,
    send: {
      request: { method: "POST", url: `${TOSEND_API_BASE}/v2/emails` },
      success: { status: 200, body: { message_id: MESSAGE_ID } },
      providerMessageId: MESSAGE_ID,
      authFailure: { status: 401, body: { status_code: 401, message: "Invalid API key" } },
      validationFailure: {
        status: 422,
        body: { status_code: 422, message: "Domain example.com is not verified" },
      },
      serverError: { status: 502, body: "Bad Gateway" },
      rateLimited: {
        status: 429,
        headers: { "retry-after": "1" },
        body: { status_code: 429, message: "Too many requests" },
      },
      batch: {
        request: { method: "POST", url: `${TOSEND_API_BASE}/v2/emails/batch` },
        success: {
          status: 200,
          body: {
            results: [
              { status: "success", message_id: "0100019a-tosend-2" },
              { status: "success", message_id: "0100019a-tosend-3" },
            ],
          },
        },
      },
    },
    readHeaders: (request) =>
      (JSON.parse(request.body) as { headers?: Record<string, string> }).headers ?? {},
    readAttachments: (request) =>
      (
        (JSON.parse(request.body) as { attachments?: { name: string; content: string }[] })
          .attachments ?? []
      ).map((item) => ({ filename: item.name, content: item.content })),
    verify: {
      ok: [
        {
          label: "GET /v2/info",
          method: "GET",
          url: `${TOSEND_API_BASE}/v2/info`,
          response: {
            status: 200,
            body: {
              account: { id: "acc_1", status: "active", credit_balance: 9800 },
              domains: [{ id: "dom_1", domain_name: "example.com" }],
            },
          },
        },
      ],
      badKey: [
        {
          label: "GET /v2/info with a wrong key",
          method: "GET",
          url: `${TOSEND_API_BASE}/v2/info`,
          response: { status: 401, body: { status_code: 401, message: "Invalid API key" } },
        },
      ],
    },
    webhook: {
      secret: TOSEND_FIXTURE_SECRET,
      sign: signToSendWebhook,
      // toSend signs only the body, with no timestamp.
      staleAt: null,
      samples: [
        {
          label: "hard bounce",
          body: toSendBounce("ana@example.org"),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              bounceDetail: { text: TOSEND_HARD_BOUNCE_REASON },
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "bounced",
              occurredAt: Date.parse("2026-10-26T11:59:58.000Z"),
            },
          ],
        },
        {
          label: "soft bounce",
          body: toSendBounce("bo@example.org", false),
          expected: [
            {
              type: "bounced",
              bounce: "soft",
              bounceDetail: { text: TOSEND_SOFT_BOUNCE_REASON },
              recipient: "bo@example.org",
            },
          ],
        },
        {
          label: "complaint",
          body: toSendComplaint("ana@example.org"),
          expected: [
            {
              type: "complained",
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "complaint",
            },
          ],
        },
        {
          label: "two bounces for two recipients in one body",
          body: `[${toSendBounce("ana@example.org")},${toSendBounce("bo@example.org")}]`,
          expected: [
            { type: "bounced", recipient: "ana@example.org" },
            { type: "bounced", recipient: "bo@example.org" },
          ],
        },
        {
          label: "an event type that mailswitch does not map",
          body: JSON.stringify({ type: "opened", data: { email: "ana@example.org" } }),
          expected: [{ type: "unknown", rawType: "opened" }],
        },
      ],
    },
  };
}
