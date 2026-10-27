// The conformance fixture of the AutoSend adapter. The exchanges and the webhook bodies
// follow the examples of the AutoSend docs (checked 2026-10-27). No answer here is a
// recording from a live account. The ids, keys, secrets, and addresses are made up.
// https://docs.autosend.com/api-reference/mails/send.md
// https://docs.autosend.com/api-reference/errors.md
// https://docs.autosend.com/api-reference/rate-limit.md
// https://docs.autosend.com/others/webhooks/event-type.md

import {
  AUTOSEND_API_BASE,
  AUTOSEND_SIGNATURE_HEADER,
  autosendSignature,
} from "../../providers/autosend/index";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

/** The made-up API key of the fixture. */
export const AUTOSEND_FIXTURE_KEY = "AS_test_not_real";
/**
 * The made-up webhook secret of the fixture. It protects nothing.
 * For tests only. Never use it in production config.
 */
export const AUTOSEND_FIXTURE_SECRET = "test-autosend-webhook-secret-not-real";
/** The email id of the accepted answer. */
export const AUTOSEND_FIXTURE_EMAIL_ID = "autosend-email-0001";
/** The send URL. */
export const AUTOSEND_FIXTURE_SEND_URL: string = `${AUTOSEND_API_BASE}/v1/mails/send`;
/** The verify URL. */
export const AUTOSEND_FIXTURE_DOMAINS_URL: string = `${AUTOSEND_API_BASE}/v1/domains`;
/** The `createdAt` of every sample event. */
export const AUTOSEND_FIXTURE_EVENT_TIME = "2026-10-27T11:59:00.000Z";

/** An accepted answer (HTTP 200) with the given email id. */
export function autosendAccepted(emailId: string = AUTOSEND_FIXTURE_EMAIL_ID): {
  success: true;
  data: { emailId: string; message: string; totalRecipients: number };
} {
  return {
    success: true,
    data: { emailId, message: "Email queued successfully.", totalRecipients: 1 },
  };
}

/** An error answer in the nested shape of the errors page. */
export function autosendError(
  code: string,
  message: string,
  fields: Record<string, unknown> = {},
): { success: false; error: Record<string, unknown> } {
  return { success: false, error: { message, code, ...fields } };
}

/** Signs a body the way AutoSend does. The timestamp header is not signed. */
export async function signAutosendWebhook(input: {
  body: Uint8Array;
  secret: string;
  at?: number;
}): Promise<WebhookSample> {
  return {
    headers: new Headers({
      [AUTOSEND_SIGNATURE_HEADER]: await autosendSignature(input.secret, input.body),
      "x-webhook-event": "email.delivered",
      "x-webhook-delivery-id": "autosend-delivery-0001",
      "x-webhook-timestamp": String(input.at ?? NOW),
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

/** One AutoSend webhook body, in the shape of the event type reference. */
export function autosendEvent(
  type: string,
  data: Record<string, unknown> = {},
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    createdAt: AUTOSEND_FIXTURE_EVENT_TIME,
    data: {
      emailId: AUTOSEND_FIXTURE_EMAIL_ID,
      from: "billing@example.com",
      to: { email: "ana@example.org", name: "Ana" },
      subject: "Your invoice",
      test: false,
      ...data,
    },
    ...fields,
  });
}

interface SentBody {
  headers?: Record<string, string>;
  attachments?: { fileName: string; content: string }[];
}

/** The fixture that drives `autosend()` through every conformance check. */
export function autosendFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: AUTOSEND_FIXTURE_KEY },
    now: NOW,
    send: {
      request: { method: "POST", url: AUTOSEND_FIXTURE_SEND_URL },
      success: { status: 200, body: autosendAccepted() },
      providerMessageId: AUTOSEND_FIXTURE_EMAIL_ID,
      authFailure: { status: 401, body: autosendError("UNAUTHORIZED", "Invalid API key") },
      validationFailure: {
        status: 400,
        body: autosendError("VALIDATION_FAILED", "Validation failed", {
          details: [{ field: "from.email", message: "Invalid email" }],
        }),
      },
      serverError: {
        status: 500,
        body: autosendError("INTERNAL_SERVER_ERROR", "Internal server error"),
      },
      rateLimited: {
        status: 429,
        headers: { "retry-after": "2" },
        body: autosendError("RATE_LIMIT_EXCEEDED", "Too many requests", { retryAfter: 2 }),
      },
    },
    readHeaders: (request) => (JSON.parse(request.body) as SentBody).headers ?? {},
    readAttachments: (request) =>
      ((JSON.parse(request.body) as SentBody).attachments ?? []).map((item) => ({
        filename: item.fileName,
        content: item.content,
      })),
    verify: {
      ok: [
        {
          label: "GET /v1/domains with a good key",
          method: "GET",
          url: AUTOSEND_FIXTURE_DOMAINS_URL,
          response: {
            status: 200,
            body: { success: true, data: { domains: [{ domain: "example.com" }] } },
          },
        },
      ],
      badKey: [
        {
          label: "GET /v1/domains with a wrong key",
          method: "GET",
          url: AUTOSEND_FIXTURE_DOMAINS_URL,
          response: { status: 401, body: autosendError("UNAUTHORIZED", "Invalid API key") },
        },
      ],
    },
    webhook: {
      secret: AUTOSEND_FIXTURE_SECRET,
      sign: signAutosendWebhook,
      // AutoSend signs only the body. The timestamp header is not signed.
      staleAt: null,
      samples: [
        {
          label: "delivered",
          body: autosendEvent("email.delivered"),
          expected: [
            {
              type: "delivered",
              rawType: "email.delivered",
              recipient: "ana@example.org",
              providerMessageId: AUTOSEND_FIXTURE_EMAIL_ID,
              occurredAt: Date.parse(AUTOSEND_FIXTURE_EVENT_TIME),
            },
          ],
        },
        {
          label: "permanent bounce",
          body: autosendEvent("email.bounced", {
            bounceType: "Permanent",
            bounceSubType: "NoEmail",
            reason: "550 5.1.1 unknown user",
          }),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              rawType: "email.bounced",
              bounceDetail: { text: "550 5.1.1 unknown user" },
            },
          ],
        },
        {
          label: "transient bounce",
          body: autosendEvent("email.bounced", {
            bounceType: "Transient",
            bounceSubType: "General",
            reason: "451 4.3.0 temporary failure",
          }),
          expected: [
            {
              type: "bounced",
              bounce: "soft",
              rawType: "email.bounced",
              bounceDetail: { text: "451 4.3.0 temporary failure" },
            },
          ],
        },
        {
          label: "spam report",
          body: autosendEvent("email.spam_reported", { complaintType: "abuse" }),
          expected: [{ type: "complained", rawType: "email.spam_reported" }],
        },
        {
          label: "an event that mailswitch does not map",
          body: autosendEvent("email.opened"),
          expected: [{ type: "unknown", rawType: "email.opened" }],
        },
      ],
    },
    canary: (field, token) => (field.name === "projectId" ? `proj-${token}` : `AS_${token}`),
  };
}
