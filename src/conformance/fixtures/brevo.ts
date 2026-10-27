// The conformance fixture of the Brevo API adapter. The exchanges follow the examples of
// the Brevo API reference (checked 2026-10-27). The bodies come from the reference, not
// from a live account. The ids, keys, and addresses are made up.
// https://developers.brevo.com/reference/sendtransacemail
// https://developers.brevo.com/reference/getaccount
// https://developers.brevo.com/docs/how-it-works
// https://developers.brevo.com/docs/limit-headers
// https://developers.brevo.com/docs/heterogenous-versions-batch-emails
//
// The webhook part is the Brevo webhook fixture of the SMTP adapter. Both adapters use
// the same code in src/internal/brevo-webhooks.ts.

import { uuidFromKey } from "../../internal/uuid";
import { BREVO_API_BASE } from "../../providers/brevo/index";
import type { ConformanceFixture } from "../types";
import { smtpFixture } from "./smtp";

const NOW = Date.parse("2026-10-27T12:00:30.000Z");
/** The message id of the accepted send, in the shape of the reference example. */
export const BREVO_FIXTURE_MESSAGE_ID = "<202610271200.90817263544@smtp-relay.mailin.fr>";
/** A made-up v3 API key. */
export const BREVO_FIXTURE_API_KEY = "xkeysib-test-fixture-not-a-real-key";

interface SentBody {
  headers?: Record<string, string>;
  attachment?: { name: string; content: string }[];
}

const error = (code: string, message: string) => ({ code, message });

/** The fixture that drives `brevo()` through every conformance check. */
export function brevoFixture(): ConformanceFixture {
  const webhook = smtpFixture().webhook;
  return {
    credentials: { apiKey: BREVO_FIXTURE_API_KEY },
    now: NOW,
    send: {
      request: { method: "POST", url: `${BREVO_API_BASE}/v3/smtp/email` },
      success: { status: 201, body: { messageId: BREVO_FIXTURE_MESSAGE_ID } },
      providerMessageId: BREVO_FIXTURE_MESSAGE_ID,
      authFailure: { status: 401, body: error("unauthorized", "Key not found") },
      validationFailure: {
        status: 400,
        body: error("invalid_parameter", "email is not valid in to"),
      },
      serverError: { status: 500, body: error("internal_error", "Internal server error") },
      // Brevo sends the seconds until the limit resets, and no Retry-After.
      rateLimited: {
        status: 429,
        headers: {
          "x-sib-ratelimit-limit": "100",
          "x-sib-ratelimit-remaining": "0",
          "x-sib-ratelimit-reset": "2",
        },
        body: error("too_many_requests", "The expected rate limit is exceeded."),
      },
      // A reused idempotencyKey within 30 minutes. The page gives the code, not the
      // status. HTTP 400 is the status of every Brevo error code.
      keyConflict: {
        status: 400,
        body: error("duplicate_parameter", "idempotencyKey already exists"),
      },
    },
    readHeaders: (request) => (JSON.parse(request.body) as SentBody).headers ?? {},
    readAttachments: (request) =>
      ((JSON.parse(request.body) as SentBody).attachment ?? []).map((item) => ({
        filename: item.name,
        content: item.content,
      })),
    readIdempotencyKey: (request) => (JSON.parse(request.body) as SentBody).headers?.idempotencyKey,
    expectedIdempotencyKey: (key) => uuidFromKey(key),
    verify: {
      ok: [
        {
          label: "GET /v3/account with a good key",
          method: "GET",
          url: `${BREVO_API_BASE}/v3/account`,
          response: {
            status: 200,
            body: {
              email: "owner@example.com",
              firstName: "Ana",
              lastName: "Example",
              companyName: "Acme",
              plan: [{ type: "free", credits: 300, creditsType: "sendLimit" }],
            },
          },
        },
      ],
      badKey: [
        {
          label: "GET /v3/account with a wrong key",
          method: "GET",
          url: `${BREVO_API_BASE}/v3/account`,
          response: { status: 401, body: error("unauthorized", "Key not found") },
        },
      ],
    },
    canary: (_field, token) => `xkeysib-${token}`,
    ...(webhook ? { webhook } : {}),
  };
}
