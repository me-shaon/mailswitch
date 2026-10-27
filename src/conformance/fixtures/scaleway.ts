// The conformance fixture of the Scaleway Transactional Email adapter. Checked 2026-10-27.
// - The success body follows the CreateEmailResponse schema of the v1alpha1 OpenAPI spec.
// - The error bodies follow the error types of the official Scaleway SDKs (`type`,
//   `message`, and `details`). They are not recordings. The spec documents only the 200.
// Scaleway documents no 429 body and no 5xx body. The ids, keys, and addresses are made
// up. The secret key protects nothing.
// https://www.scaleway.com/en/developers/api/transactional-email/v1alpha1/schema.yml
// https://www.scaleway.com/en/developers/api/

import { SCALEWAY_API_BASE, SCALEWAY_TEM_PATH } from "../../providers/scaleway/index";
import type { RecordedHttpResponse } from "../mock-fetch";
import type { ConformanceFixture } from "../types";

const BASE = `${SCALEWAY_API_BASE}${SCALEWAY_TEM_PATH}`;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
/** A made-up secret key. It protects nothing. */
export const SCALEWAY_FIXTURE_SECRET_KEY = "00000000-0000-4000-8000-00000000test";
/** A made-up Project ID. */
export const SCALEWAY_FIXTURE_PROJECT_ID = "11111111-2222-4333-8444-555555555555";
/** The made-up `id` of the first email in the success answer. */
export const SCALEWAY_EMAIL_ID = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
/** The send URL. */
export const SCALEWAY_SEND_URL: string = `${BASE}/emails`;
/** The verify URL of the fixture Project. */
export const SCALEWAY_VERIFY_URL: string = `${BASE}/domains?project_id=${SCALEWAY_FIXTURE_PROJECT_ID}&page_size=1`;

/** Any verify URL on the API origin. The redaction check changes the Project ID. */
const VERIFY_URL =
  /^https:\/\/api\.scaleway\.com\/transactional-email\/v1alpha1\/regions\/fr-par\/domains\?project_id=[A-Za-z0-9-]+&page_size=1$/;

const json = { "content-type": "application/json" };

/** One entry of `emails[]` in a send answer. */
export function scalewayEmail(
  id: string,
  rcpt: string,
  rcptType = "to",
  status = "new",
): Record<string, unknown> {
  return {
    id,
    message_id: `${id}@scw-tem.cloud`,
    project_id: SCALEWAY_FIXTURE_PROJECT_ID,
    mail_from: "billing@example.com",
    mail_rcpt: rcpt,
    rcpt_type: rcptType,
    subject: "Hi",
    created_at: "2026-10-27T12:00:00.000000Z",
    updated_at: "2026-10-27T12:00:00.000000Z",
    status,
    try_count: 0,
    last_tries: [],
    flags: [],
  };
}

/** A 200 send answer with the given entries. */
export function scalewayAnswer(
  emails: Record<string, unknown>[] = [scalewayEmail(SCALEWAY_EMAIL_ID, "ana@example.org")],
): RecordedHttpResponse {
  return { status: 200, headers: json, body: { emails } };
}

/** An error answer in the `{ type, message, details }` shape of the Scaleway API. */
export function scalewayError(
  status: number,
  type: string,
  message: string,
  details: Record<string, unknown>[] = [],
): RecordedHttpResponse {
  return { status, headers: json, body: { details, message, type } };
}

/** A wrong secret key. */
export const SCALEWAY_BAD_KEY: RecordedHttpResponse = {
  status: 401,
  headers: json,
  body: {
    message: "authentication is denied",
    method: "api_key",
    reason: "invalid_argument",
    type: "denied_authentication",
  },
};

/** A refused message: a sender that is not valid. */
export const SCALEWAY_INVALID: RecordedHttpResponse = scalewayError(
  400,
  "invalid_arguments",
  "invalid argument(s)",
  [{ argument_name: "from.email", reason: "constraint", help_message: "must be a valid email" }],
);

/** A 200 domain list with one domain. */
export const SCALEWAY_DOMAINS: RecordedHttpResponse = {
  status: 200,
  headers: json,
  body: {
    total_count: 1,
    domains: [
      {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-000000000002",
        organization_id: "11111111-2222-4333-8444-000000000000",
        project_id: SCALEWAY_FIXTURE_PROJECT_ID,
        name: "example.com",
        status: "checked",
        region: "fr-par",
      },
    ],
  },
};

interface SentBody {
  additional_headers?: { key: string; value: string }[];
  attachments?: { name: string; content: string }[];
}

const parse = (body: string) => JSON.parse(body) as SentBody;

/** The fixture that drives `scaleway()` through every conformance check. */
export function scalewayFixture(): ConformanceFixture {
  return {
    credentials: {
      secretKey: SCALEWAY_FIXTURE_SECRET_KEY,
      projectId: SCALEWAY_FIXTURE_PROJECT_ID,
    },
    now: NOW,
    send: {
      request: { method: "POST", url: SCALEWAY_SEND_URL },
      success: scalewayAnswer(),
      providerMessageId: SCALEWAY_EMAIL_ID,
      authFailure: SCALEWAY_BAD_KEY,
      validationFailure: SCALEWAY_INVALID,
      serverError: { status: 503, body: "Service Unavailable" },
      // Scaleway documents no rate limit body. The kit default (429, Retry-After 2) applies.
    },
    readHeaders: (request) =>
      Object.fromEntries(
        (parse(request.body).additional_headers ?? [])
          .filter((item) => item.key.toLowerCase() !== "reply-to")
          .map((item) => [item.key, item.value]),
      ),
    readAttachments: (request) =>
      (parse(request.body).attachments ?? []).map((item) => ({
        filename: item.name,
        content: item.content,
      })),
    verify: {
      ok: [
        {
          label: "GET .../domains with a good key",
          method: "GET",
          url: VERIFY_URL,
          response: SCALEWAY_DOMAINS,
        },
      ],
      badKey: [
        {
          label: "GET .../domains with a wrong key",
          method: "GET",
          url: VERIFY_URL,
          response: SCALEWAY_BAD_KEY,
        },
      ],
    },
  };
}
