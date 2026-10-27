// The conformance fixture of the Mailtrap adapter. The exchanges and the webhook bodies
// follow the examples of the Mailtrap docs (checked 2026-10-27). No answer here is a
// recording from a live account. The ids, tokens, secrets, and addresses are made up.
// https://docs.mailtrap.io/developers/email-sending/transactional/send-transactional-email.md
// https://docs.mailtrap.io/developers/authentication.md
// https://docs.mailtrap.io/email-api-smtp/advanced/webhooks.md

import {
  MAILTRAP_ACCOUNTS_BASE,
  MAILTRAP_HOSTS,
  MAILTRAP_SIGNATURE_HEADER,
  mailtrapSignature,
} from "../../providers/mailtrap/index";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

/** The made-up API token of the fixture. */
export const MAILTRAP_FIXTURE_TOKEN = "test-mailtrap-token-not-real";
/** The made-up webhook secret of the fixture. It protects nothing. */
export const MAILTRAP_FIXTURE_SECRET = "test-mailtrap-webhook-secret-not-real";
/** The message id of the accepted answer. */
export const MAILTRAP_FIXTURE_MESSAGE_ID = "mailtrap-message-0001";
/** The transactional send URL. */
export const MAILTRAP_FIXTURE_SEND_URL: string = `${MAILTRAP_HOSTS.transactional}/api/send`;
/** The verify URL. */
export const MAILTRAP_FIXTURE_ACCOUNTS_URL: string = `${MAILTRAP_ACCOUNTS_BASE}/api/accounts`;
/** The Unix time in seconds of every sample event. */
export const MAILTRAP_FIXTURE_EVENT_TIME = 1_793_102_340;

/** An accepted answer (HTTP 200) with the given ids. */
export function mailtrapAccepted(ids: string[] = [MAILTRAP_FIXTURE_MESSAGE_ID]): {
  success: true;
  message_ids: string[];
} {
  return { success: true, message_ids: ids };
}

/** An error answer in the documented shape. */
export function mailtrapError(...errors: string[]): { success: false; errors: string[] } {
  return { success: false, errors };
}

/** Signs a body the way Mailtrap does. Mailtrap signs no timestamp. */
export async function signMailtrapWebhook(input: {
  body: Uint8Array;
  secret: string;
}): Promise<WebhookSample> {
  return {
    headers: new Headers({
      [MAILTRAP_SIGNATURE_HEADER]: await mailtrapSignature(input.secret, input.body),
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

/** One Mailtrap webhook event, in the shape of the webhook reference. */
export function mailtrapEvent(
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event,
    timestamp: MAILTRAP_FIXTURE_EVENT_TIME,
    sending_stream: "transactional",
    category: "Invoice",
    custom_variables: {},
    message_id: MAILTRAP_FIXTURE_MESSAGE_ID,
    email: "ana@example.org",
    event_id: `mailtrap-event-${event.replace(/ /g, "-")}-0001`,
    sending_domain_name: "example.com",
    ...fields,
  };
}

/** A Mailtrap webhook body with the given events. */
export function mailtrapEvents(...events: Record<string, unknown>[]): string {
  return JSON.stringify({ events });
}

interface SentBody {
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string }[];
}

/** The fixture that drives `mailtrap()` through every conformance check. */
export function mailtrapFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: MAILTRAP_FIXTURE_TOKEN },
    now: NOW,
    send: {
      request: { method: "POST", url: MAILTRAP_FIXTURE_SEND_URL },
      success: { status: 200, body: mailtrapAccepted() },
      providerMessageId: MAILTRAP_FIXTURE_MESSAGE_ID,
      authFailure: { status: 401, body: mailtrapError("Unauthorized") },
      validationFailure: { status: 400, body: mailtrapError("'from' address is required") },
      serverError: { status: 500, body: mailtrapError("Internal Server Error") },
      // The rate limit page documents 429 with no header. The suite needs Retry-After.
      rateLimited: {
        status: 429,
        headers: { "retry-after": "2" },
        body: mailtrapError("Rate limit exceeded"),
      },
    },
    readHeaders: (request) => (JSON.parse(request.body) as SentBody).headers ?? {},
    readAttachments: (request) =>
      ((JSON.parse(request.body) as SentBody).attachments ?? []).map((item) => ({
        filename: item.filename,
        content: item.content,
      })),
    verify: {
      ok: [
        {
          label: "GET https://mailtrap.io/api/accounts with a good token",
          method: "GET",
          url: MAILTRAP_FIXTURE_ACCOUNTS_URL,
          response: {
            status: 200,
            body: [{ id: 1001, name: "Example account", access_levels: [100] }],
          },
        },
      ],
      badKey: [
        {
          label: "GET https://mailtrap.io/api/accounts with a wrong token",
          method: "GET",
          url: MAILTRAP_FIXTURE_ACCOUNTS_URL,
          response: { status: 401, body: { error: "Incorrect API token" } },
        },
      ],
    },
    webhook: {
      secret: MAILTRAP_FIXTURE_SECRET,
      sign: signMailtrapWebhook,
      // Mailtrap signs only the body, with no timestamp.
      staleAt: null,
      samples: [
        {
          label: "delivery and a soft bounce in one body",
          body: mailtrapEvents(
            mailtrapEvent("delivery"),
            mailtrapEvent("soft bounce", {
              email: "bo@example.org",
              response: "451 4.7.1 try again later",
              response_code: 451,
              bounce_category: "greylisting",
            }),
          ),
          expected: [
            {
              type: "delivered",
              rawType: "delivery",
              recipient: "ana@example.org",
              providerMessageId: MAILTRAP_FIXTURE_MESSAGE_ID,
              eventKey: "mailtrap-event-delivery-0001",
              occurredAt: MAILTRAP_FIXTURE_EVENT_TIME * 1000,
            },
            {
              type: "bounced",
              bounce: "soft",
              rawType: "soft bounce",
              recipient: "bo@example.org",
              eventKey: "mailtrap-event-soft-bounce-0001",
            },
          ],
        },
        {
          label: "hard bounce",
          body: mailtrapEvents(
            mailtrapEvent("bounce", {
              response: "550 5.1.1 unknown user",
              response_code: 550,
              bounce_category: "invalid_recipient",
            }),
          ),
          expected: [{ type: "bounced", bounce: "hard", rawType: "bounce" }],
        },
        {
          label: "spam complaint",
          body: mailtrapEvents(mailtrapEvent("spam")),
          expected: [{ type: "complained", rawType: "spam" }],
        },
        {
          label: "an event that mailswitch does not map",
          body: mailtrapEvents(mailtrapEvent("reject", { reason: "suppressed" })),
          expected: [
            { type: "unknown", rawType: "reject", eventKey: "mailtrap-event-reject-0001" },
          ],
        },
      ],
    },
  };
}
