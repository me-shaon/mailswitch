// The conformance fixture of the generic HTTP provider. The provider has no fixed
// endpoint, so the fixture drives a sample JSON config of a made-up API at
// `mail.example.test`. The answers are not recordings. They follow the shape that the
// sample config reads. The token, the ids, and the addresses are made up. The token
// protects nothing. Checked 2026-10-27.

import type { HttpProviderConfig } from "../../providers/http/config";
import type { RecordedHttpResponse } from "../mock-fetch";
import type { ConformanceFixture } from "../types";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

/** The made-up token of the fixture. */
export const HTTP_FIXTURE_TOKEN = "test-http-token-not-real";
/** The send URL of the sample config. */
export const HTTP_SEND_URL = "https://mail.example.test/v1/send";
/** The verify URL of the sample config. */
export const HTTP_VERIFY_URL = "https://mail.example.test/v1/account";
/** The allowlist of the sample config. */
export const HTTP_FIXTURE_ALLOW_HOSTS: readonly string[] = Object.freeze(["mail.example.test"]);
/** The made-up message id of the success answer. */
export const HTTP_MESSAGE_ID = "msg-0001";

/** A sample config that maps every message part. */
export function httpFixtureConfig(): HttpProviderConfig {
  return {
    id: "examplemail",
    name: "Example Mail",
    endpoint: HTTP_SEND_URL,
    method: "POST",
    auth: { type: "bearer" },
    fields: {
      from: "from",
      to: "to",
      cc: "cc",
      bcc: "bcc",
      replyTo: "reply_to",
      subject: "subject",
      html: "html",
      text: "text",
      headers: "headers",
      attachments: "attachments",
    },
    attachmentFields: { filename: "name", content: "data", contentType: "type", contentId: "cid" },
    addressFormat: "object",
    idFrom: "data.messageId",
    verify: { endpoint: HTTP_VERIFY_URL, method: "GET" },
  };
}

const json = { "content-type": "application/json" };

/** The 200 send answer of the sample API. */
export const HTTP_SENT: RecordedHttpResponse = {
  status: 200,
  headers: json,
  body: { data: { messageId: HTTP_MESSAGE_ID, status: "queued" } },
};

/** A wrong token. */
export const HTTP_BAD_TOKEN: RecordedHttpResponse = {
  status: 401,
  headers: json,
  body: { error: { code: "unauthorized", message: "The token is not valid." } },
};

/** A refused message. */
export const HTTP_INVALID: RecordedHttpResponse = {
  status: 422,
  headers: json,
  body: { error: { code: "invalid_from", message: "The sender is not valid." } },
};

/** The 200 account answer of the sample API. */
export const HTTP_ACCOUNT: RecordedHttpResponse = {
  status: 200,
  headers: json,
  body: { data: { plan: "free" } },
};

interface SentBody {
  headers?: Record<string, string>;
  attachments?: { name: string; data: string }[];
}

const parse = (body: string) => JSON.parse(body) as SentBody;

/** The fixture that drives the sample config through every conformance check. */
export function httpFixture(): ConformanceFixture {
  return {
    credentials: { token: HTTP_FIXTURE_TOKEN },
    now: NOW,
    send: {
      request: { method: "POST", url: HTTP_SEND_URL },
      success: HTTP_SENT,
      providerMessageId: HTTP_MESSAGE_ID,
      authFailure: HTTP_BAD_TOKEN,
      validationFailure: HTTP_INVALID,
      serverError: { status: 503, body: "Service Unavailable" },
    },
    readHeaders: (request) => parse(request.body).headers ?? {},
    readAttachments: (request) =>
      (parse(request.body).attachments ?? []).map((item) => ({
        filename: item.name,
        content: item.data,
      })),
    verify: {
      ok: [
        {
          label: "GET /v1/account with a good token",
          method: "GET",
          url: HTTP_VERIFY_URL,
          response: HTTP_ACCOUNT,
        },
      ],
      badKey: [
        {
          label: "GET /v1/account with a wrong token",
          method: "GET",
          url: HTTP_VERIFY_URL,
          response: HTTP_BAD_TOKEN,
        },
      ],
    },
  };
}
