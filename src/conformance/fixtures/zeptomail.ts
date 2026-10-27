// The conformance fixture of the ZeptoMail adapter. Checked 2026-10-27.
// - The success body follows the example of the email sending reference.
// - The wrong-token body was observed on api.zeptomail.com on 2026-10-27, with a made-up
//   token.
// - The 400 bodies follow the two error shapes of the reference and the error code list.
//   They are not recordings.
// - The verify answer of a good token (400 TM_3201) is expected, not yet recorded. The
//   release gate of the provider guide records it live.
// ZeptoMail documents no 429 body and no 5xx body. The ids, tokens, and addresses are
// made up.
// https://www.zoho.com/zeptomail/help/api/email-sending.html
// https://www.zoho.com/zeptomail/help/api/error-codes.html

import { ZEPTOMAIL_HOSTS } from "../../providers/zeptomail/index";
import type { RecordedHttpResponse } from "../mock-fetch";
import type { ConformanceFixture } from "../types";

const BASE = ZEPTOMAIL_HOSTS.com;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
/** The made-up `request_id` of the success answer. */
export const ZEPTOMAIL_REQUEST_ID =
  "2d6f.5e8b1c2a7f3d9e41.m1.0a1b2c3d-b3f4-11f1-9e2a-5254000fixture.19a2b3c4d5e";
/** A made-up Send Mail token. It protects nothing. */
export const ZEPTOMAIL_FIXTURE_TOKEN =
  "wSsVR60fixtureOnlyZeptomailToken0123456789abcdefABCDEF+/xyz==";

const json = { "content-type": "application/json" };

/** A 200 send answer with the given code. */
export function zeptomailAnswer(
  code = "EM_104",
  requestId: string = ZEPTOMAIL_REQUEST_ID,
): RecordedHttpResponse {
  return {
    status: 200,
    headers: json,
    body: {
      data: [{ code, additional_info: [], message: "Email request received" }],
      message: "OK",
      request_id: requestId,
      object: "email",
    },
  };
}

/** An error answer in the `{ error: { code, details, message, request_id } }` shape. */
export function zeptomailError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown>[] = [],
): RecordedHttpResponse {
  return {
    status,
    headers: json,
    body: { error: { code, details, message, request_id: "13ef.7a1c2b3d4e5f6a7b" } },
  };
}

/** An error answer in the `{ data: { error_code, message }, message: "error" }` shape. */
export function zeptomailDataError(
  status: number,
  code: string,
  message: string,
): RecordedHttpResponse {
  return { status, headers: json, body: { data: { error_code: code, message }, message: "error" } };
}

/** A wrong token, as api.zeptomail.com answered on 2026-10-27. */
export const ZEPTOMAIL_BAD_TOKEN: RecordedHttpResponse = {
  status: 401,
  headers: json,
  body: {
    error: {
      code: "TM_4001",
      details: [{ code: "SERR_157", message: "Invalid API Token found" }],
      message: "Access Denied",
    },
  },
};

/** A request with no recipient: the expected verify answer of a good token. */
export const ZEPTOMAIL_NO_RECIPIENT: RecordedHttpResponse = zeptomailError(
  400,
  "TM_3201",
  "Mandatory Field Missing",
  [{ message: "Mandatory field 'to' is missing.", target: "to" }],
);

interface SentBody {
  mime_headers?: Record<string, string>;
  attachments?: { name: string; content: string }[];
  inline_images?: { name: string; content: string }[];
}

const parse = (body: string) => JSON.parse(body) as SentBody;

/** The fixture that drives `zeptomail()` through every conformance check. */
export function zeptomailFixture(): ConformanceFixture {
  return {
    credentials: { token: ZEPTOMAIL_FIXTURE_TOKEN },
    // The fromAddress pattern needs an address. The token takes the raw canary.
    canary: (field, token) => (field.name === "fromAddress" ? `${token}@example.com` : token),
    now: NOW,
    send: {
      request: { method: "POST", url: `${BASE}/v1.1/email` },
      success: zeptomailAnswer(),
      providerMessageId: ZEPTOMAIL_REQUEST_ID,
      authFailure: ZEPTOMAIL_BAD_TOKEN,
      validationFailure: zeptomailDataError(400, "TM_3201", "Mandatory Field Missing"),
      serverError: { status: 503, body: "Service Unavailable" },
      // ZeptoMail documents no rate limit. The kit default (429, Retry-After 2) applies.
    },
    readHeaders: (request) => parse(request.body).mime_headers ?? {},
    readAttachments: (request) => {
      const body = parse(request.body);
      return [...(body.attachments ?? []), ...(body.inline_images ?? [])].map((item) => ({
        filename: item.name,
        content: item.content,
      }));
    },
    verify: {
      ok: [
        {
          label: "POST /v1.1/email with no recipient and a good token",
          method: "POST",
          url: `${BASE}/v1.1/email`,
          response: ZEPTOMAIL_NO_RECIPIENT,
        },
      ],
      badKey: [
        {
          label: "POST /v1.1/email with no recipient and a wrong token",
          method: "POST",
          url: `${BASE}/v1.1/email`,
          response: ZEPTOMAIL_BAD_TOKEN,
        },
      ],
    },
  };
}
