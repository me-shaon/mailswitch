// The conformance fixture of the Lettermill adapter. Lettermill is fictional, so it has no
// test account. The exchanges copy the examples of https://lettermill.example/docs/api
// (checked 2026-10-26). Ids, keys, and addresses are made up.

import type { ConformanceFixture } from "../../../src/conformance/index";
import { LETTERMILL_API_BASE, lettermillSignature } from "./index";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const MESSAGE_ID = "lm_msg_01JB7Q2W3E";
const ACCOUNT_URL = `${LETTERMILL_API_BASE}/v1/account`;
const SECRET = "lmwhsec_test0secret0value0123";

interface SentBody {
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string }[];
}

/** One Lettermill webhook body. */
export function lettermillEvent(
  id: string,
  type: string,
  data: Record<string, string> = {},
): string {
  return JSON.stringify({
    id,
    type,
    created_at: "2026-10-26T11:59:00.000Z",
    data: { message_id: MESSAGE_ID, recipient: "ana@example.org", ...data },
  });
}

/** The fixture that drives `lettermill()` through every conformance check. */
export function lettermillFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: "lm_live_test0key0123" },
    now: NOW,
    send: {
      request: { method: "POST", url: `${LETTERMILL_API_BASE}/v1/messages` },
      success: { status: 200, body: { id: MESSAGE_ID } },
      providerMessageId: MESSAGE_ID,
      authFailure: {
        status: 401,
        body: { error: { code: "invalid_key", message: "The API key is not valid." } },
      },
      validationFailure: {
        status: 422,
        body: { error: { code: "invalid_message", message: "The from address is not valid." } },
      },
      serverError: { status: 503, body: "Service Unavailable" },
      rateLimited: {
        status: 429,
        headers: { "retry-after": "2" },
        body: { error: { code: "rate_limited", message: "Too many requests." } },
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
          label: "GET /v1/account with a good key",
          method: "GET",
          url: ACCOUNT_URL,
          response: { status: 200, body: { account: { name: "Example Co", plan: "starter" } } },
        },
      ],
      badKey: [
        {
          label: "GET /v1/account with a wrong key",
          method: "GET",
          url: ACCOUNT_URL,
          response: {
            status: 401,
            body: { error: { code: "invalid_key", message: "The API key is not valid." } },
          },
        },
      ],
    },
    webhook: {
      secret: SECRET,
      async sign({ body, secret, at }) {
        const timestamp = String(Math.floor(at / 1000));
        return {
          headers: new Headers({
            "content-type": "application/json",
            "lettermill-timestamp": timestamp,
            "lettermill-signature": await lettermillSignature(secret, timestamp, body),
          }),
          body,
        };
      },
      // Ten minutes before NOW: outside the 5 minute window.
      staleAt: NOW - 10 * 60 * 1000,
      samples: [
        {
          label: "delivered",
          body: lettermillEvent("evt_delivered_1", "message.delivered"),
          expected: [
            {
              type: "delivered",
              eventKey: "evt_delivered_1",
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "message.delivered",
              occurredAt: Date.parse("2026-10-26T11:59:00.000Z"),
            },
          ],
        },
        {
          label: "hard bounce",
          body: lettermillEvent("evt_bounce_1", "message.bounced", { bounce_kind: "hard" }),
          expected: [{ type: "bounced", bounce: "hard", eventKey: "evt_bounce_1" }],
        },
        {
          label: "soft bounce",
          body: lettermillEvent("evt_bounce_2", "message.bounced", { bounce_kind: "soft" }),
          expected: [{ type: "bounced", bounce: "soft", eventKey: "evt_bounce_2" }],
        },
        {
          label: "complaint",
          body: lettermillEvent("evt_complaint_1", "message.complained"),
          expected: [{ type: "complained", eventKey: "evt_complaint_1" }],
        },
        {
          label: "an event type that mailswitch does not map",
          body: lettermillEvent("evt_open_1", "message.opened"),
          expected: [{ type: "unknown", rawType: "message.opened" }],
        },
      ],
    },
    // The key pattern needs the `lm_live_` prefix. The default canary keeps only `lm_`.
    canary: (_field, token) => `lm_live_${token}`,
  };
}
