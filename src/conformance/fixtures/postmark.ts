// The conformance fixture of the Postmark adapter. The exchanges and the webhook bodies
// follow the examples of the Postmark API reference (checked 2026-10-26). Postmark has a
// test token, but it does not cover webhooks, so every body here comes from the reference.
// The ids, tokens, and addresses are made up.
// https://postmarkapp.com/developer/api/email-api
// https://postmarkapp.com/developer/api/server-api
// https://postmarkapp.com/developer/webhooks/bounce-webhook
// https://postmarkapp.com/developer/webhooks/delivery-webhook
// https://postmarkapp.com/developer/webhooks/spam-complaint-webhook

import { POSTMARK_API_BASE, postmarkWebhookAuthorization } from "../../providers/postmark/index";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const MESSAGE_ID = "883953f4-6105-42a2-a16a-77a8eac79483";
/**
 * The webhook secret of the fixture: 32 base64url characters (192 bits).
 * For tests only. Never use it in production config.
 */
export const POSTMARK_FIXTURE_SECRET = "Zm9yLXRlc3RzLW9ubHktbm90LXJlYWwh";

/**
 * Signs a body the way Postmark does: with Basic auth. Basic auth covers no body and no
 * time, so the helper ignores `at`.
 */
export async function signPostmarkWebhook(input: {
  body: Uint8Array;
  secret: string;
  at?: number;
}): Promise<WebhookSample> {
  return {
    headers: new Headers({
      authorization: postmarkWebhookAuthorization(input.secret),
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

interface SentBody {
  Headers?: { Name: string; Value: string }[];
  Attachments?: { Name: string; Content: string }[];
}

/** The `Details` of the sample hard bounce: the SMTP reply of the remote server. */
export const POSTMARK_HARD_BOUNCE_DETAILS =
  "smtp;550 5.1.1 The email account that you tried to reach does not exist.";

/** The `Description` of every sample bounce. */
export const POSTMARK_BOUNCE_DESCRIPTION =
  "The server was unable to deliver your message (ex: unknown user, mailbox not found).";

/** A Postmark bounce webhook body. `id` is the bounce ID, a 64-bit integer. */
export function postmarkBounce(
  email: string,
  type: string = "HardBounce",
  id: string = "692560173",
  messageId: string = MESSAGE_ID,
  details: string = POSTMARK_HARD_BOUNCE_DETAILS,
): string {
  const codes: Record<string, number> = {
    HardBounce: 1,
    Transient: 2,
    SoftBounce: 4096,
    AutoResponder: 16,
  };
  // The ID goes in as raw digits, as Postmark sends it, so a 64-bit ID keeps every digit.
  return `{"RecordType":"Bounce","MessageStream":"outbound","ID":${id},"Type":${JSON.stringify(type)},"TypeCode":${codes[type] ?? 0},"Name":"Hard bounce","Tag":"Test","MessageID":"${messageId}","Metadata":{"a_key":"a_value"},"ServerID":23,"Description":${JSON.stringify(POSTMARK_BOUNCE_DESCRIPTION)},"Details":${JSON.stringify(details)},"Email":${JSON.stringify(email)},"From":"sender@example.com","BouncedAt":"2026-10-26T11:59:58Z","DumpAvailable":true,"Inactive":true,"CanActivate":true,"Subject":"Test subject","Content":"Test content"}`;
}

/** A Postmark delivery webhook body. A delivery has no ID. */
export function postmarkDelivery(recipient: string, messageId: string = MESSAGE_ID): string {
  return JSON.stringify({
    RecordType: "Delivery",
    ServerID: 23,
    MessageStream: "outbound",
    MessageID: messageId,
    Recipient: recipient,
    Tag: "welcome-email",
    DeliveredAt: "2026-10-26T11:59:59Z",
    Details: "Test delivery webhook details",
    Metadata: { example: "value" },
  });
}

/** A Postmark spam complaint webhook body. */
export function postmarkSpamComplaint(email: string, messageId: string = MESSAGE_ID): string {
  return JSON.stringify({
    RecordType: "SpamComplaint",
    MessageStream: "outbound",
    ID: 42,
    Type: "SpamComplaint",
    TypeCode: 512,
    Name: "Spam complaint",
    Tag: "Test",
    MessageID: messageId,
    ServerID: 1234,
    Description: "The subscriber explicitly marked this message as spam.",
    Details: "Test spam complaint details",
    Email: email,
    From: "sender@example.com",
    BouncedAt: "2026-10-26T11:59:57Z",
    DumpAvailable: true,
    Inactive: true,
    CanActivate: false,
    Subject: "Test subject",
  });
}

/** The fixture that drives `postmark()` through every conformance check. */
export function postmarkFixture(): ConformanceFixture {
  return {
    credentials: { serverToken: "0f8e5b3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b" },
    now: NOW,
    send: {
      request: { method: "POST", url: `${POSTMARK_API_BASE}/email` },
      success: {
        status: 200,
        body: {
          To: "receiver@example.com",
          SubmittedAt: "2026-10-26T12:00:29.0000000-04:00",
          MessageID: MESSAGE_ID,
          ErrorCode: 0,
          Message: "OK",
        },
      },
      providerMessageId: MESSAGE_ID,
      authFailure: {
        status: 401,
        body: {
          ErrorCode: 10,
          Message:
            "The Server Token you provided in the X-Postmark-Server-Token request header was invalid.",
        },
      },
      validationFailure: {
        status: 422,
        body: { ErrorCode: 300, Message: "Invalid 'To' address: 'not-an-address'." },
      },
      serverError: { status: 500, body: { ErrorCode: 101, Message: "Unexpected error." } },
      batch: {
        request: { method: "POST", url: `${POSTMARK_API_BASE}/email/batch` },
        success: {
          status: 200,
          body: [
            {
              ErrorCode: 0,
              Message: "OK",
              MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
              SubmittedAt: "2026-10-26T12:00:29.0000000-04:00",
              To: "receiver1@example.com",
            },
            {
              ErrorCode: 0,
              Message: "OK",
              MessageID: "e2ecbbfc-fe12-463d-b933-9fe22915106d",
              SubmittedAt: "2026-10-26T12:00:29.0000000-04:00",
              To: "receiver2@example.com",
            },
          ],
        },
      },
    },
    readHeaders: (request) =>
      Object.fromEntries(
        ((JSON.parse(request.body) as SentBody).Headers ?? []).map((item) => [
          item.Name,
          item.Value,
        ]),
      ),
    readAttachments: (request) =>
      ((JSON.parse(request.body) as SentBody).Attachments ?? []).map((item) => ({
        filename: item.Name,
        content: item.Content,
      })),
    verify: {
      ok: [
        {
          label: "GET /server",
          method: "GET",
          url: `${POSTMARK_API_BASE}/server`,
          response: {
            status: 200,
            body: { ID: 1, Name: "Staging Testing", ApiTokens: ["redacted"], Color: "red" },
          },
        },
      ],
      badKey: [
        {
          label: "GET /server with a wrong token",
          method: "GET",
          url: `${POSTMARK_API_BASE}/server`,
          response: {
            status: 401,
            body: { ErrorCode: 10, Message: "No Account or Server API tokens were supplied." },
          },
        },
      ],
    },
    webhook: {
      secret: POSTMARK_FIXTURE_SECRET,
      sign: signPostmarkWebhook,
      // Basic auth covers no timestamp.
      staleAt: null,
      // Basic auth covers no body either, so a changed JSON body passes the password
      // check. This tamper breaks the JSON. The check proves only that a broken body is
      // refused. The dedupe store and HTTPS protect the rest.
      tamper: (body) => body.slice(0, Math.max(1, body.length - 2)),
      samples: [
        {
          label: "hard bounce",
          body: postmarkBounce("ana@example.org"),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              bounceDetail: { text: POSTMARK_HARD_BOUNCE_DETAILS },
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "Bounce",
              eventKey: "Bounce:692560173",
              occurredAt: Date.parse("2026-10-26T11:59:58Z"),
            },
          ],
        },
        {
          label: "soft bounce with a 64-bit ID and empty details",
          body: postmarkBounce("bo@example.org", "SoftBounce", "9007199254740993", MESSAGE_ID, ""),
          expected: [
            {
              type: "bounced",
              bounce: "soft",
              bounceDetail: { text: POSTMARK_BOUNCE_DESCRIPTION },
              recipient: "bo@example.org",
              eventKey: "Bounce:9007199254740993",
            },
          ],
        },
        {
          label: "delivery",
          body: postmarkDelivery("Ana@Example.org"),
          expected: [
            {
              type: "delivered",
              recipient: "Ana@Example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "Delivery",
              eventKey: `Delivery:${MESSAGE_ID}:ana@example.org`,
              occurredAt: Date.parse("2026-10-26T11:59:59Z"),
            },
          ],
        },
        {
          label: "spam complaint",
          body: postmarkSpamComplaint("ana@example.org"),
          expected: [
            {
              type: "complained",
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "SpamComplaint",
              eventKey: "SpamComplaint:42",
            },
          ],
        },
        {
          label: "a bounce type that is not a delivery failure",
          body: postmarkBounce("ana@example.org", "AutoResponder", "692560174"),
          expected: [{ type: "unknown", rawType: "Bounce", eventKey: "Bounce:692560174" }],
        },
        {
          label: "a record type that mailswitch does not map",
          body: JSON.stringify({
            RecordType: "Open",
            MessageID: MESSAGE_ID,
            Recipient: "ana@example.org",
            ReceivedAt: "2026-10-26T12:00:10Z",
          }),
          expected: [
            {
              type: "unknown",
              rawType: "Open",
              recipient: "ana@example.org",
              eventKey: `Open:${MESSAGE_ID}:ana@example.org:2026-10-26T12:00:10Z`,
            },
          ],
        },
      ],
    },
  };
}
