// The conformance fixture of the fake provider in the `fetch` transport. It is also a
// worked example of the fixture format for a custom provider.

import type { ConformanceFixture } from "../conformance/types";
import { bytesToHex } from "../internal/encoding";
import { hmacSign } from "../internal/hmac";
import { FAKE_API_BASE, FAKE_SIGNATURE_HEADER, fakeSignedPayload } from "./fake-provider";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const MESSAGE_ID = "fk_msg_0001";

function events(list: Record<string, string>[]): string {
  return JSON.stringify({ events: list });
}

/** The fixture that drives `fakeProvider({ transport: "fetch" })` through every check. */
export function fakeFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: "fk_test0123456789" },
    now: NOW,
    send: {
      request: { method: "POST", url: `${FAKE_API_BASE}/emails` },
      success: { status: 200, body: { id: MESSAGE_ID } },
      providerMessageId: MESSAGE_ID,
      authFailure: { status: 401, body: { error: "invalid_api_key" } },
      validationFailure: { status: 422, body: { error: "invalid_from" } },
      serverError: { status: 500, body: { error: "internal" } },
      rateLimited: { status: 429, headers: { "retry-after": "3" }, body: { error: "slow_down" } },
      keyConflict: { status: 409, body: { error: "idempotency_key_in_use" } },
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
          label: "account with a good key",
          method: "GET",
          url: `${FAKE_API_BASE}/account`,
          response: { status: 200, body: { id: "acct_1" } },
        },
      ],
      badKey: [
        {
          label: "account with a wrong key",
          method: "GET",
          url: `${FAKE_API_BASE}/account`,
          response: { status: 401, body: { error: "invalid_api_key" } },
        },
      ],
    },
    webhook: {
      secret: "fake-webhook-secret-0123456789",
      async sign({ body, secret, at }) {
        const seconds = Math.floor(at / 1000);
        const signature = bytesToHex(await hmacSign(secret, fakeSignedPayload(seconds, body)));
        return {
          headers: new Headers({ [FAKE_SIGNATURE_HEADER]: `t=${seconds},v1=${signature}` }),
          body,
        };
      },
      staleAt: NOW - 10 * 60 * 1000,
      samples: [
        {
          label: "hard bounce",
          body: events([
            {
              id: "evt_1",
              type: "bounce",
              bounce_type: "hard",
              recipient: "ana@example.org",
              message_id: MESSAGE_ID,
              occurred_at: "2026-10-26T12:00:00.000Z",
            },
          ]),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              eventKey: "evt_1",
              rawType: "bounce",
              occurredAt: Date.parse("2026-10-26T12:00:00.000Z"),
            },
          ],
        },
        {
          label: "two soft bounces of one message",
          body: events([
            { id: "evt_2", type: "bounce", bounce_type: "soft", message_id: MESSAGE_ID },
            { id: "evt_3", type: "bounce", bounce_type: "soft", message_id: MESSAGE_ID },
          ]),
          expected: [
            { type: "bounced", bounce: "soft", eventKey: "evt_2" },
            { type: "bounced", bounce: "soft", eventKey: "evt_3" },
          ],
        },
        {
          label: "complaint and delivery",
          body: events([
            { id: "evt_4", type: "complaint", recipient: "bo@example.org" },
            { id: "evt_5", type: "delivered", recipient: "bo@example.org" },
          ]),
          expected: [
            { type: "complained", recipient: "bo@example.org" },
            { type: "delivered", recipient: "bo@example.org" },
          ],
        },
        {
          label: "an event type that mailswitch does not map",
          body: events([{ id: "evt_6", type: "opened" }]),
          expected: [{ type: "unknown", rawType: "opened" }],
        },
      ],
    },
  };
}
