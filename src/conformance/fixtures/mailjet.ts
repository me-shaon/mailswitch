// The conformance fixture of the Mailjet adapter. The exchanges and the webhook bodies
// follow the examples and the field lists of the Mailjet API reference (checked
// 2026-10-27). Mailjet documents no 429 body and no 401 body. The 401 body here is the
// HTML page that Mailjet sends for bad Basic credentials, and the 429 body is empty. The
// ids, keys, secrets, and addresses are made up.
// https://dev.mailjet.com/openapi/openapi-mailjet/send-emails/postsendv31.md
// https://dev.mailjet.com/docs/email-api/send-api-v31/send-api-errors.md
// https://dev.mailjet.com/docs/email-api/webhooks/webhooks-overview.md
// https://dev.mailjet.com/docs/email-api/webhooks/event-types.md

import { MAILJET_API_BASE, mailjetWebhookAuthorization } from "../../providers/mailjet/index";
import type { RecordedHttpResponse } from "../mock-fetch";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const MESSAGE_UUID = "1ab23cd4-e567-4901-a345-6789f0ab1c2d";
/** A 64-bit MessageID. It is beyond the safe range of a JS number. */
export const MAILJET_FIXTURE_MESSAGE_ID = "19421777835146490";
/** The webhook secret of the fixture. It protects nothing. */
export const MAILJET_FIXTURE_SECRET = "test-mailjet-webhook-secret-not-real";

/** The HTML page of a 401. The adapter must never copy it into a result. */
export const MAILJET_UNAUTHORIZED_HTML =
  "<!DOCTYPE html><html><head><title>401 Unauthorized</title></head><body><h1>Unauthorized</h1><p>This server could not verify that you are authorized to access the document requested.</p></body></html>";

/** A 401 answer, as Mailjet sends it for bad Basic credentials. */
export const MAILJET_UNAUTHORIZED: RecordedHttpResponse = {
  status: 401,
  headers: {
    "content-type": "text/html",
    "www-authenticate": 'Basic realm="Provide an apiKey and secretKey"',
  },
  body: MAILJET_UNAUTHORIZED_HTML,
};

/** One success entry of a send answer, as raw JSON text with a 64-bit MessageID. */
export function mailjetSuccessEntry(
  email: string,
  uuid: string = MESSAGE_UUID,
  messageId: string = MAILJET_FIXTURE_MESSAGE_ID,
): string {
  return `{"Status":"success","CustomID":"","To":[{"Email":${JSON.stringify(email)},"MessageUUID":${JSON.stringify(uuid)},"MessageID":${messageId},"MessageHref":"https://api.mailjet.com/v3/REST/message/${messageId}"}],"Cc":[],"Bcc":[]}`;
}

/** One error entry of a send answer. */
export function mailjetErrorEntry(
  ...errors: { code?: string; status?: number; related?: string }[]
): Record<string, unknown> {
  return {
    Status: "error",
    Errors: errors.map((error) => ({
      ErrorIdentifier: "f987008f-251a-4dff-8ffc-40f1583ad7bc",
      ErrorCode: error.code ?? "mj-0013",
      ...(error.status === undefined ? {} : { StatusCode: error.status }),
      ErrorMessage: '"not-an-address" is an invalid email address.',
      ErrorRelatedTo: [error.related ?? "To[0].Email"],
    })),
  };
}

/** A send answer: the `Messages` array of the given entries, as JSON text. */
export function mailjetAnswer(...entries: (string | Record<string, unknown>)[]): string {
  const parts = entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
  return `{"Messages":[${parts.join(",")}]}`;
}

/** One Mailjet event object, in the shape of the event type reference. */
export function mailjetEvent(
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event,
    time: 1793102394,
    MessageID: 1234567890123456,
    Message_GUID: MESSAGE_UUID,
    email: "ana@example.org",
    mj_campaign_id: 7257,
    mj_contact_id: 4,
    customcampaign: "",
    CustomID: "invoice-1",
    Payload: "",
    ...fields,
  };
}

/** The Authorization header of a signed sample. Mailjet signs no body and no time. */
export async function signMailjetWebhook(input: {
  body: Uint8Array;
  secret: string;
}): Promise<WebhookSample> {
  return {
    headers: new Headers({
      authorization: mailjetWebhookAuthorization(input.secret),
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

interface SentBody {
  Messages?: {
    Headers?: Record<string, string>;
    Attachments?: { Filename: string; Base64Content: string }[];
    InlinedAttachments?: { Filename: string; Base64Content: string }[];
  }[];
}

const first = (body: string) => (JSON.parse(body) as SentBody).Messages?.[0] ?? {};

/** The fixture that drives `mailjet()` through every conformance check. */
export function mailjetFixture(): ConformanceFixture {
  return {
    credentials: {
      apiKey: "testmailjetapikeynotreal0000",
      secretKey: "testmailjetsecretnotreal0000",
    },
    now: NOW,
    send: {
      request: { method: "POST", url: `${MAILJET_API_BASE}/v3.1/send` },
      success: { status: 200, body: mailjetAnswer(mailjetSuccessEntry("receiver@example.com")) },
      providerMessageId: MESSAGE_UUID,
      authFailure: MAILJET_UNAUTHORIZED,
      validationFailure: { status: 400, body: mailjetAnswer(mailjetErrorEntry({ status: 400 })) },
      serverError: {
        status: 500,
        body: {
          ErrorIdentifier: "6d0e9b1c-1f8e-4f3a-9c27-0d3b1f6a2e11",
          StatusCode: 500,
          ErrorMessage: "Internal Server Error",
        },
      },
      // Mailjet documents no Retry-After header and no body for a 429.
      rateLimited: { status: 429, body: "" },
      batch: {
        request: { method: "POST", url: `${MAILJET_API_BASE}/v3.1/send` },
        success: {
          status: 200,
          body: mailjetAnswer(
            mailjetSuccessEntry("receiver@example.com"),
            mailjetSuccessEntry(
              "second@example.org",
              "2bc34de5-f678-4012-b456-789a0bc1d2e3",
              "19421777835146491",
            ),
          ),
        },
      },
    },
    readHeaders: (request) => first(request.body).Headers ?? {},
    readAttachments: (request) => {
      const entry = first(request.body);
      return [...(entry.Attachments ?? []), ...(entry.InlinedAttachments ?? [])].map((item) => ({
        filename: item.Filename,
        content: item.Base64Content,
      }));
    },
    verify: {
      ok: [
        {
          label: "GET /v3/REST/user with good keys",
          method: "GET",
          url: `${MAILJET_API_BASE}/v3/REST/user`,
          response: {
            status: 200,
            body: {
              Count: 1,
              Data: [{ ID: 4242, Email: "owner@example.com", Locale: "en_US" }],
              Total: 1,
            },
          },
        },
      ],
      badKey: [
        {
          label: "GET /v3/REST/user with wrong keys",
          method: "GET",
          url: `${MAILJET_API_BASE}/v3/REST/user`,
          response: MAILJET_UNAUTHORIZED,
        },
      ],
    },
    webhook: {
      secret: MAILJET_FIXTURE_SECRET,
      sign: signMailjetWebhook,
      // Basic auth covers no timestamp.
      staleAt: null,
      // Basic auth covers no body either, so a changed JSON body passes the password
      // check. This tamper breaks the JSON. The check proves only that a broken body is
      // refused. The dedupe store and HTTPS protect the rest.
      tamper: (body) => body.slice(0, Math.max(1, body.length - 2)),
      samples: [
        {
          label: "sent (Version 1, one object)",
          body: JSON.stringify(
            mailjetEvent("sent", {
              mj_message_id: "1234567890123456",
              smtp_reply: "sent (250 2.0.0 OK)",
            }),
          ),
          expected: [
            {
              type: "delivered",
              rawType: "sent",
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_UUID,
              eventKey: "sent:1234567890123456:ana@example.org:1793102394",
              occurredAt: 1793102394000,
            },
          ],
        },
        {
          label: "hard bounce with a 64-bit MessageID",
          body: `{"event":"bounce","time":1793102395,"MessageID":${MAILJET_FIXTURE_MESSAGE_ID},"Message_GUID":"${MESSAGE_UUID}","email":"bo@example.org","blocked":false,"hard_bounce":true,"error_related_to":"recipient","error":"user unknown"}`,
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              bounceDetail: { text: "user unknown (recipient)" },
              recipient: "bo@example.org",
              eventKey: `bounce:${MAILJET_FIXTURE_MESSAGE_ID}:bo@example.org:1793102395`,
            },
          ],
        },
        {
          label: "Version 2 list: soft bounce, spam, and blocked",
          body: JSON.stringify([
            mailjetEvent("bounce", {
              hard_bounce: false,
              error_related_to: "domain",
              error: "mailbox full",
            }),
            mailjetEvent("spam", { source: "JMRPP" }),
            mailjetEvent("blocked", { error_related_to: "recipient", error: "preblocked" }),
          ]),
          expected: [
            {
              type: "bounced",
              bounce: "soft",
              rawType: "bounce",
              bounceDetail: { text: "mailbox full (domain)" },
            },
            { type: "complained", rawType: "spam" },
            {
              type: "unknown",
              rawType: "blocked",
              eventKey: "blocked:1234567890123456:ana@example.org:1793102394",
            },
          ],
        },
        {
          label: "an event that mailswitch does not map",
          body: JSON.stringify(
            mailjetEvent("click", { url: "https://example.com/invoice", ip: "192.0.2.1" }),
          ),
          expected: [
            {
              type: "unknown",
              rawType: "click",
              eventKey:
                "click:1234567890123456:ana@example.org:1793102394:https://example.com/invoice",
            },
          ],
        },
      ],
    },
  };
}
