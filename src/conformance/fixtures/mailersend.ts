// The conformance fixture of the MailerSend adapter. The exchanges and the webhook bodies
// follow the examples of the MailerSend API reference (checked 2026-10-27). The ids,
// tokens, secrets, and addresses are made up.
// https://developers.mailersend.com/api/v1/email
// https://developers.mailersend.com/general
// https://developers.mailersend.com/guides/checking-api-quota
// https://developers.mailersend.com/api/v1/account/webhooks

import {
  MAILERSEND_API_BASE,
  MAILERSEND_SIGNATURE_HEADER,
  mailersendSignature,
} from "../../providers/mailersend/index";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const MESSAGE_ID = "6892766ae78995a317577aa1";

/**
 * The webhook signing secret of the fixture. It protects nothing.
 * For tests only. Never use it in production config.
 */
export const MAILERSEND_FIXTURE_SECRET = "fixture-signing-secret-AbCdEf0123456789";

/** Signs a body the way MailerSend does. MailerSend signs no timestamp. */
export async function signMailersendWebhook(input: {
  body: Uint8Array;
  secret: string;
  /** The signing time. This provider signs no time, so the helper ignores it. */
  at?: number;
}): Promise<WebhookSample> {
  return {
    headers: new Headers({
      [MAILERSEND_SIGNATURE_HEADER]: await mailersendSignature(input.secret, input.body),
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

/** One MailerSend webhook body, in the shape of the webhook reference. */
export function mailersendEvent(
  type: string,
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  const suffix = type.replace(/^activity\./, "");
  return {
    type,
    created_at: "2026-10-27T11:59:54.000000Z",
    data: {
      id: `act-${suffix}-0001`,
      domain_id: "yv69oxl5kl785kw2",
      message_id: MESSAGE_ID,
      email_id: "6892766a8d52ba62543d5e71",
      type: suffix,
      subject: "Your invoice",
      recipient: "ana@example.org",
      tags: ["invoice"],
      meta: [],
      ...data,
    },
  };
}

interface SentBody {
  headers?: { name: string; value: string }[];
  attachments?: { filename: string; content: string }[];
}

const ERROR = (field: string, text: string) => ({
  message: "The given data was invalid.",
  errors: { [field]: [text] },
});

/** The fixture that drives `mailersend()` through every conformance check. */
export function mailersendFixture(): ConformanceFixture {
  return {
    credentials: {
      apiKey: "mlsn.test-mailersend-token-not-real",
    },
    now: NOW,
    send: {
      request: { method: "POST", url: `${MAILERSEND_API_BASE}/v1/email` },
      success: { status: 202, headers: { "x-message-id": MESSAGE_ID }, body: "" },
      providerMessageId: MESSAGE_ID,
      authFailure: { status: 401, body: { message: "Unauthenticated." } },
      validationFailure: {
        status: 422,
        body: ERROR("to.0.email", "The to.0.email must be a valid email address. #MS42208"),
      },
      serverError: { status: 500, body: { message: "Server Error" } },
      rateLimited: {
        status: 429,
        headers: {
          "retry-after": "2",
          "x-ratelimit-limit": "120",
          "x-ratelimit-remaining": "0",
        },
        body: { message: "Too Many Attempts." },
      },
    },
    readHeaders: (request) =>
      Object.fromEntries(
        ((JSON.parse(request.body) as SentBody).headers ?? []).map((item) => [
          item.name,
          item.value,
        ]),
      ),
    readAttachments: (request) =>
      ((JSON.parse(request.body) as SentBody).attachments ?? []).map((item) => ({
        filename: item.filename,
        content: item.content,
      })),
    verify: {
      ok: [
        {
          label: "GET /v1/api-quota with a good token",
          method: "GET",
          url: `${MAILERSEND_API_BASE}/v1/api-quota`,
          response: {
            status: 200,
            body: { quota: 1000, remaining: 752, reset: "2026-10-28T00:00:00Z" },
          },
        },
      ],
      badKey: [
        {
          label: "GET /v1/api-quota with a wrong token",
          method: "GET",
          url: `${MAILERSEND_API_BASE}/v1/api-quota`,
          response: { status: 401, body: { message: "Unauthenticated." } },
        },
      ],
    },
    canary: (_field, token) => `mlsn.${token}`,
    webhook: {
      secret: MAILERSEND_FIXTURE_SECRET,
      sign: signMailersendWebhook,
      // MailerSend signs only the body, with no timestamp.
      staleAt: null,
      samples: [
        {
          label: "delivered",
          body: JSON.stringify(mailersendEvent("activity.delivered")),
          expected: [
            {
              type: "delivered",
              rawType: "activity.delivered",
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              eventKey: "act-delivered-0001",
              occurredAt: Date.parse("2026-10-27T11:59:54.000Z"),
            },
          ],
        },
        {
          label: "hard bounce",
          body: JSON.stringify(
            mailersendEvent("activity.hard_bounced", {
              meta: {
                bounce_reason: "550 5.1.1 unknown user",
                bounce_code: 550,
                bounce_type: "hard",
              },
            }),
          ),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              bounceDetail: { text: "550 5.1.1 unknown user", smtpCode: 550 },
              rawType: "activity.hard_bounced",
              eventKey: "act-hard_bounced-0001",
            },
          ],
        },
        {
          label: "soft bounce",
          body: JSON.stringify(
            mailersendEvent("activity.soft_bounced", {
              recipient: "bo@example.org",
              meta: {
                bounce_reason: "452 4.2.2 mailbox full",
                bounce_code: 452,
                bounce_type: "soft",
              },
            }),
          ),
          expected: [
            {
              type: "bounced",
              bounce: "soft",
              recipient: "bo@example.org",
              bounceDetail: { text: "452 4.2.2 mailbox full", smtpCode: 452 },
            },
          ],
        },
        {
          label: "spam complaint",
          body: JSON.stringify(
            mailersendEvent("activity.spam_complaint", { type: "spam_complaints" }),
          ),
          expected: [{ type: "complained", rawType: "activity.spam_complaint" }],
        },
        {
          label: "an event that mailswitch does not map",
          body: JSON.stringify(mailersendEvent("activity.opened")),
          expected: [{ type: "unknown", rawType: "activity.opened", eventKey: "act-opened-0001" }],
        },
      ],
    },
  };
}
