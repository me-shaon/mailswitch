// The conformance fixture of the SMTP2GO adapter. The success, validation, and verify
// bodies follow the examples of the SMTP2GO API reference (checked 2026-10-27). The
// wrong-key bodies were observed on api.smtp2go.com on 2026-10-27, with made-up keys.
// SMTP2GO documents no 429 body and no 5xx body. The ids, keys, secrets, and addresses
// are made up.
// https://developers.smtp2go.com/reference/send-standard-email.md
// https://developers.smtp2go.com/reference/view-api-key-permissions.md
// https://developers.smtp2go.com/docs/response-codes
// https://developers.smtp2go.com/docs/webhooks-overview.md

import { SMTP2GO_REGIONS, smtp2goWebhookAuth } from "../../providers/smtp2go/index";
import type { RecordedHttpResponse } from "../mock-fetch";
import type { ConformanceFixture, WebhookSample } from "../types";

const BASE = SMTP2GO_REGIONS.global;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const EMAIL_ID = "1u0SwL-B9zBpi9ffUq-JAB2";
/** The webhook secret of the fixture. It protects nothing. */
export const SMTP2GO_FIXTURE_SECRET = "test-smtp2go-webhook-secret-not-real";
/** A made-up API key in the documented format. */
export const SMTP2GO_FIXTURE_KEY = "api-0A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p";

/** A 200 send answer with the given counts. A null `emailId` leaves out `email_id`. */
export function smtp2goAnswer(
  succeeded: number,
  failed = 0,
  failures: string[] = [],
  emailId: string | null = EMAIL_ID,
): RecordedHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      request_id: "aa253464-0bd0-467a-b24b-6159dcd7be60",
      data: {
        succeeded,
        failed,
        failures,
        ...(emailId === null ? {} : { email_id: emailId }),
      },
    },
  };
}

/** An error answer in the documented `{ request_id, data: { error, error_code } }` shape. */
export function smtp2goError(
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): RecordedHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: {
      request_id: "22e5acba-43bf-11e6-ae42-408d5cce2644",
      data: { error, error_code: code, ...extra },
    },
  };
}

/** A wrong key, as api.smtp2go.com answered on 2026-10-27. */
export const SMTP2GO_BAD_KEY: RecordedHttpResponse = smtp2goError(
  400,
  "E_ApiResponseCodes.API_EXCEPTION",
  "An API User matching the passed 'api_key' was not found, Please check the key is correct and try again, The full API key can be found in the API Keys section in the admin console - Code(01JKVS9D5DPXZZZ0TM7KM84EGD)",
);

/** No key, or a key in the wrong format, as api.smtp2go.com answered on 2026-10-27. */
export const SMTP2GO_MISSING_KEY: RecordedHttpResponse = smtp2goError(
  403,
  "E_ApiResponseCodes.INVALID_IN_PAYLOAD",
  "The 'api_key' parameter was not found in the request payload or in the 'X-Smtp2go-Api-Key' header or it wasn't in the correct format 'api-[A-Za-z0-9]{32}'; this is required for an API call to function. Please amend your request to include your full 'api_key' and ensure that you include the Content-Type header, set to 'application/json'. The full key can be found in the API Keys section in the admin console - Code(01JM0WWHT96Y867DPGESCFZTA5)",
);

/** A field validation error, from the response codes page. */
export const SMTP2GO_INVALID_SENDER: RecordedHttpResponse = smtp2goError(
  400,
  "E_ApiResponseCodes.NON_VALIDATING_IN_PAYLOAD",
  "An error occurred processing the json data you sent with the request, please make sure the data conforms to the specification for this call (see the documentation here: https://apidoc.smtp2go.com/documentation/#/README) and try again. Don't forget to set Content-Type to 'application/json'.",
  {
    field_validation_errors: {
      fieldname: "sender",
      message:
        "The field 'sender' was expecting a valid RFC-822 formatted email field but found 'robs_invalid.com', Please correct your JSON payload and try again.",
    },
  },
);

/** One SMTP2GO event object, with the fields of the webhooks overview. */
export function smtp2goEvent(
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `b1c2d3e4f5a6-${event}`,
    event,
    time: "2026-10-27T11:59:30Z",
    sendtime: "2026-10-27T11:59:20Z",
    email_id: EMAIL_ID,
    rcpt: "ana@example.org",
    sender: "billing@example.com",
    from_address: "billing@example.com",
    subject: "Your invoice",
    "message-id": "<invoice-1@example.com>",
    ...fields,
  };
}

/** The Bearer header of a signed sample. SMTP2GO signs no body and no time. */
export async function signSmtp2goWebhook(input: {
  body: Uint8Array;
  secret: string;
}): Promise<WebhookSample> {
  return {
    headers: new Headers({
      authorization: `Bearer ${smtp2goWebhookAuth(input.secret).auth_header_value}`,
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

interface SentBody {
  custom_headers?: { header: string; value: string }[];
  attachments?: { filename: string; fileblob: string }[];
  inlines?: { filename: string; fileblob: string }[];
}

const parse = (body: string) => JSON.parse(body) as SentBody;
const permissions = (data: string[]): RecordedHttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: { request_id: "f3e50113-deb2-4e54-9675-2ea497c3732e", data },
});

/** The fixture that drives `smtp2go()` through every conformance check. */
export function smtp2goFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: SMTP2GO_FIXTURE_KEY },
    // The key pattern needs exactly 32 letters and digits after `api-`.
    canary: (_field, token) => `api-${token.padEnd(32, "0").slice(0, 32)}`,
    now: NOW,
    send: {
      request: { method: "POST", url: `${BASE}/v3/email/send` },
      success: smtp2goAnswer(1),
      providerMessageId: EMAIL_ID,
      authFailure: SMTP2GO_BAD_KEY,
      validationFailure: SMTP2GO_INVALID_SENDER,
      serverError: { status: 503, body: "Service Unavailable" },
      // SMTP2GO documents no Retry-After header and no body for a 429.
      rateLimited: { status: 429, body: "" },
    },
    readHeaders: (request) =>
      Object.fromEntries(
        (parse(request.body).custom_headers ?? []).map((item) => [item.header, item.value]),
      ),
    readAttachments: (request) => {
      const body = parse(request.body);
      return [...(body.attachments ?? []), ...(body.inlines ?? [])].map((item) => ({
        filename: item.filename,
        content: item.fileblob,
      }));
    },
    verify: {
      ok: [
        {
          label: "POST /v3/api_keys/permissions with a good key",
          method: "POST",
          url: `${BASE}/v3/api_keys/permissions`,
          response: permissions(["/email/send", "/api_keys/view"]),
        },
      ],
      badKey: [
        {
          label: "POST /v3/api_keys/permissions with a wrong key",
          method: "POST",
          url: `${BASE}/v3/api_keys/permissions`,
          response: SMTP2GO_BAD_KEY,
        },
      ],
    },
    webhook: {
      secret: SMTP2GO_FIXTURE_SECRET,
      sign: signSmtp2goWebhook,
      // The token covers no timestamp.
      staleAt: null,
      // The token covers no body either, so a changed JSON body passes the token check.
      // This tamper breaks the JSON. The check proves only that a broken body is refused.
      // The dedupe store and HTTPS protect the rest.
      tamper: (body) => body.slice(0, Math.max(1, body.length - 2)),
      samples: [
        {
          label: "delivered",
          body: JSON.stringify(smtp2goEvent("delivered", { host: "mx.example.org" })),
          expected: [
            {
              type: "delivered",
              rawType: "delivered",
              recipient: "ana@example.org",
              providerMessageId: EMAIL_ID,
              eventKey: "b1c2d3e4f5a6-delivered",
              occurredAt: Date.parse("2026-10-27T11:59:30Z"),
            },
          ],
        },
        {
          label: "hard bounce",
          body: JSON.stringify(
            smtp2goEvent("bounce", { bounce: "hard", context: "550 5.1.1 user unknown" }),
          ),
          expected: [{ type: "bounced", bounce: "hard", eventKey: "b1c2d3e4f5a6-bounce" }],
        },
        {
          label: "soft bounce",
          body: JSON.stringify(
            smtp2goEvent("bounce", { id: "c2d3e4f5a6b7-bounce", bounce: "soft" }),
          ),
          expected: [{ type: "bounced", bounce: "soft", eventKey: "c2d3e4f5a6b7-bounce" }],
        },
        {
          label: "spam complaint",
          body: JSON.stringify(smtp2goEvent("spam")),
          expected: [{ type: "complained", rawType: "spam" }],
        },
        {
          label: "an event that mailswitch does not map",
          body: JSON.stringify(smtp2goEvent("open", { "user-agent": "Mail/1.0" })),
          expected: [{ type: "unknown", rawType: "open", eventKey: "b1c2d3e4f5a6-open" }],
        },
      ],
    },
  };
}
