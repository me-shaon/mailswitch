// The conformance fixture of the AhaSend adapter. The exchanges and the webhook bodies
// follow the examples and the schemas of the AhaSend docs (checked 2026-10-27). No answer
// here is a recording from a live account. The ids, keys, and addresses are made up.
// https://ahasend.com/docs/api-reference/messages/create-conversation.md
// https://ahasend.com/docs/api-reference/errors.md
// https://ahasend.com/docs/api-reference/idempotency.md
// https://ahasend.com/docs/api-reference/utility/ping.md
// https://ahasend.com/docs/api-reference/webhooks/security.md
// https://ahasend.com/docs/integrations/webhooks.md

import { bytesToBase64 } from "../../internal/encoding";
import { hmacSign } from "../../internal/hmac";
import {
  AHASEND_API_BASE,
  AHASEND_ID_HEADER,
  AHASEND_SIGNATURE_HEADER,
  AHASEND_TIMESTAMP_HEADER,
  ahasendIdempotencyKey,
  ahasendSignedPayload,
} from "../../providers/ahasend/index";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-27T12:00:30.000Z");
/** The made-up account id of the fixture. */
export const AHASEND_FIXTURE_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
/** The made-up API key of the fixture. */
export const AHASEND_FIXTURE_API_KEY = "aha-sk-test-not-real-not-real-not-real";
/** The made-up webhook secret of the fixture, with its prefix. */
export const AHASEND_FIXTURE_SECRET = "aha-whsec-test-fixture-not-real";
/** The `webhook-id` of every signed sample. */
export const AHASEND_FIXTURE_DELIVERY_ID = "ahasend-delivery-0001";
/** The message id of the accepted answer. */
export const AHASEND_FIXTURE_MESSAGE_ID = "ahasend-message-0001";
/** The send URL for the fixture account. */
export const AHASEND_FIXTURE_SEND_URL: string = `${AHASEND_API_BASE}/v2/accounts/${AHASEND_FIXTURE_ACCOUNT_ID}/messages/conversation`;

/** One entry of the `data` list of an accepted answer. */
export interface AhasendEntry {
  id?: string | null;
  recipient?: string;
  status?: string;
  error?: string | null;
}

/** An accepted answer (HTTP 202) with the given entries. */
export function ahasendAccepted(
  entries: AhasendEntry[] = [
    {
      id: AHASEND_FIXTURE_MESSAGE_ID,
      recipient: "ana@example.org",
      status: "queued",
      error: null,
    },
  ],
): Record<string, unknown> {
  return {
    object: "list",
    data: entries.map((entry) => ({ object: "message", ...entry })),
  };
}

/** Signs a body the way AhaSend does, with Standard Webhooks headers. */
export async function signAhasendWebhook(input: {
  body: Uint8Array;
  secret: string;
  at: number;
  id?: string;
}): Promise<WebhookSample> {
  const id = input.id ?? AHASEND_FIXTURE_DELIVERY_ID;
  const timestamp = String(Math.floor(input.at / 1000));
  // The key is the literal secret text, with its prefix.
  const signature = bytesToBase64(
    await hmacSign(input.secret, ahasendSignedPayload(id, timestamp, input.body)),
  );
  return {
    headers: new Headers({
      [AHASEND_ID_HEADER]: id,
      [AHASEND_TIMESTAMP_HEADER]: timestamp,
      [AHASEND_SIGNATURE_HEADER]: `v1,${signature}`,
    }),
    body: input.body,
  };
}

/** An AhaSend webhook body. */
export function ahasendEvent(type: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    webhook_id: "ahasend-webhook-0001",
    timestamp: "2026-10-27T12:00:00.123456789Z",
    data: {
      account_id: AHASEND_FIXTURE_ACCOUNT_ID,
      from: "billing@example.com",
      recipient: "ana@example.org",
      subject: "Invoice 42",
      message_id_header: "<invoice-42@example.com>",
      id: AHASEND_FIXTURE_MESSAGE_ID,
      ...data,
    },
  });
}

function error(message: string): { message: string } {
  return { message };
}

const OCCURRED_AT = Date.parse("2026-10-27T12:00:00.123Z");

/** The fixture that drives `ahasend()` through every conformance check. */
export function ahasendFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: AHASEND_FIXTURE_API_KEY, accountId: AHASEND_FIXTURE_ACCOUNT_ID },
    now: NOW,
    send: {
      request: { method: "POST", url: AHASEND_FIXTURE_SEND_URL },
      success: { status: 202, body: ahasendAccepted() },
      providerMessageId: AHASEND_FIXTURE_MESSAGE_ID,
      authFailure: { status: 401, body: error("Invalid API key") },
      validationFailure: { status: 400, body: error("Invalid request: from.email is required") },
      serverError: { status: 500, body: error("Internal server error") },
      rateLimited: {
        status: 429,
        headers: { "retry-after": "2" },
        body: error("Rate limit exceeded"),
      },
      keyConflict: {
        status: 409,
        headers: { "retry-after": "1" },
        body: error("A request with the same idempotency key is in progress"),
      },
    },
    readHeaders: (request) =>
      (JSON.parse(request.body) as { headers?: Record<string, string> }).headers ?? {},
    readAttachments: (request) =>
      (
        (JSON.parse(request.body) as { attachments?: { file_name: string; data: string }[] })
          .attachments ?? []
      ).map((item) => ({ filename: item.file_name, content: item.data })),
    expectedIdempotencyKey: (key) => ahasendIdempotencyKey(key),
    verify: {
      ok: [
        {
          label: "GET /v2/ping with a good key",
          method: "GET",
          url: `${AHASEND_API_BASE}/v2/ping`,
          response: { status: 200, body: { message: "pong" } },
        },
      ],
      badKey: [
        {
          label: "GET /v2/ping with a wrong key",
          method: "GET",
          url: `${AHASEND_API_BASE}/v2/ping`,
          response: { status: 401, body: error("Invalid API key") },
        },
      ],
    },
    // The account id pattern takes no "cnry" text in a UUID, so the canary keeps the
    // allowed characters. The key keeps its prefix.
    canary: (field, token) => (field.name === "accountId" ? `acct-${token}` : `aha-sk-${token}`),
    webhook: {
      secret: AHASEND_FIXTURE_SECRET,
      sign: (input) => signAhasendWebhook(input),
      staleAt: NOW - 10 * 60 * 1000,
      samples: [
        {
          label: "delivery",
          body: ahasendEvent("message.delivered", {
            delivery_attempt: { smtp_code: 250, enhanced_status_code: "2.0.0" },
          }),
          expected: [
            {
              type: "delivered",
              recipient: "ana@example.org",
              providerMessageId: AHASEND_FIXTURE_MESSAGE_ID,
              eventKey: AHASEND_FIXTURE_DELIVERY_ID,
              rawType: "message.delivered",
              occurredAt: OCCURRED_AT,
            },
          ],
        },
        {
          label: "bounce",
          body: ahasendEvent("message.bounced", {
            delivery_attempt: { smtp_code: 550, enhanced_status_code: "5.1.1" },
          }),
          expected: [{ type: "bounced", rawType: "message.bounced" }],
        },
        {
          label: "transient error",
          body: ahasendEvent("message.transient_error", {
            delivery_attempt: { smtp_code: 452, enhanced_status_code: "4.2.2" },
          }),
          expected: [{ type: "bounced", bounce: "soft", rawType: "message.transient_error" }],
        },
        {
          label: "complaint",
          body: ahasendEvent("message.complained"),
          expected: [{ type: "complained", recipient: "ana@example.org" }],
        },
        {
          label: "an event type that mailswitch does not map",
          body: ahasendEvent("message.opened"),
          expected: [{ type: "unknown", rawType: "message.opened" }],
        },
      ],
    },
  };
}
