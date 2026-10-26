// The conformance fixture of the Amazon SES adapter. The responses follow the SES v2 API
// reference and its error list. There is no SES test account in CI, so the bodies come
// from the documented shapes, with made-up ids (2026-10-26).
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/CommonErrors.html
// The webhook samples follow the SES event publishing examples:
// https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html

import type { CapturedRequest } from "../mock-fetch";
import { createSnsSigner, type SnsMessage, type SnsSigner } from "../sns-signer";
import type { CapturedAttachment, ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
/** The SES API origin of the fixture region. */
export const SES_FIXTURE_API = "https://email.us-east-1.amazonaws.com";
/** The allowlisted topic of the fixture. */
export const SES_FIXTURE_TOPIC = "arn:aws:sns:us-east-1:123456789012:mailswitch-ses-events";
/** The signing certificate URL of every signed sample. */
export const SES_FIXTURE_CERT_URL =
  "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem";
/** The SES message id of the sample events. */
export const SES_FIXTURE_MESSAGE_ID =
  "010001926d7a1c3e-5f3b6c1a-8e2d-4b7a-9f10-2c3d4e5f6a7b-000000";
/** The SNS MessageId of the bounce sample. */
export const SES_FIXTURE_SNS_ID = "8f6b0f4e-4a0e-5d2b-9c1e-3a7d2b6c9e01";

let signer: SnsSigner | null = null;
let pending: Promise<SnsSigner> | null = null;

/** The shared test signer. Its certificate is served at `SES_FIXTURE_CERT_URL`. */
export async function sesFixtureSigner(): Promise<SnsSigner> {
  pending ??= createSnsSigner().then((created) => {
    signer = created;
    return created;
  });
  return pending;
}

/** An SNS envelope without the signature fields, as JSON text. */
export function snsEnvelope(fields: Partial<SnsMessage>): string {
  return JSON.stringify({
    Type: "Notification",
    MessageId: SES_FIXTURE_SNS_ID,
    TopicArn: SES_FIXTURE_TOPIC,
    Message: "",
    ...fields,
  });
}

/** An SNS notification that carries one SES event. */
export function sesNotification(
  event: Record<string, unknown>,
  snsId: string = SES_FIXTURE_SNS_ID,
): string {
  return snsEnvelope({
    MessageId: snsId,
    Message: JSON.stringify({
      mail: {
        timestamp: "2026-10-26T11:59:00.000Z",
        messageId: SES_FIXTURE_MESSAGE_ID,
        source: "billing@example.com",
        destination: ["ana@example.org"],
      },
      ...event,
    }),
  });
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Signs an SNS envelope the way SNS does. It sets the topic (the first ARN of the
 * secret), the `Timestamp` (`at`), and the certificate URL, then signs with version 2.
 */
export async function signSesWebhook(input: {
  body: Uint8Array;
  secret: string;
  at: number;
  version?: "1" | "2";
  certUrl?: string;
}): Promise<WebhookSample> {
  const sns = await sesFixtureSigner();
  const fields = JSON.parse(decoder.decode(input.body)) as SnsMessage;
  const topic = input.secret.split(",")[0]?.trim() || SES_FIXTURE_TOPIC;
  const signed = await sns.sign(
    {
      ...fields,
      TopicArn: topic,
      Timestamp: new Date(input.at).toISOString(),
      SigningCertURL: input.certUrl ?? SES_FIXTURE_CERT_URL,
    },
    input.version ?? "2",
  );
  return {
    headers: new Headers({
      "content-type": "text/plain; charset=UTF-8",
      "x-amz-sns-message-type": signed.Type,
      "x-amz-sns-message-id": signed.MessageId,
      "x-amz-sns-topic-arn": signed.TopicArn,
    }),
    body: encoder.encode(JSON.stringify(signed)),
  };
}

function simple(request: CapturedRequest): Record<string, unknown> {
  const body = JSON.parse(request.body) as { Content?: { Simple?: Record<string, unknown> } };
  return body.Content?.Simple ?? {};
}

/** The fixture that drives `ses()` through every conformance check. */
export function sesFixture(): ConformanceFixture {
  return {
    credentials: {
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    now: NOW,
    send: {
      request: { method: "POST", url: `${SES_FIXTURE_API}/v2/email/outbound-emails` },
      success: { status: 200, body: { MessageId: SES_FIXTURE_MESSAGE_ID } },
      providerMessageId: SES_FIXTURE_MESSAGE_ID,
      authFailure: {
        status: 403,
        headers: { "x-amzn-errortype": "UnrecognizedClientException" },
        body: { message: "The security token included in the request is invalid." },
      },
      validationFailure: {
        status: 400,
        headers: { "x-amzn-errortype": "BadRequestException" },
        body: { message: "Missing required header 'From'." },
      },
      serverError: {
        status: 500,
        headers: { "x-amzn-errortype": "InternalFailure" },
        body: { message: "An internal error occurred." },
      },
      rateLimited: {
        status: 429,
        headers: { "x-amzn-errortype": "TooManyRequestsException" },
        body: { message: "Maximum sending rate exceeded." },
      },
    },
    readHeaders(request) {
      const list = simple(request).Headers;
      const out: Record<string, string> = {};
      if (Array.isArray(list)) {
        for (const item of list as { Name: string; Value: string }[]) out[item.Name] = item.Value;
      }
      return out;
    },
    readAttachments(request): CapturedAttachment[] {
      const list = simple(request).Attachments;
      if (!Array.isArray(list)) return [];
      return (list as { FileName: string; RawContent: string }[]).map((item) => ({
        filename: item.FileName,
        content: item.RawContent,
      }));
    },
    verify: {
      ok: [
        {
          label: "GetAccount with good credentials",
          method: "GET",
          url: `${SES_FIXTURE_API}/v2/email/account`,
          response: {
            status: 200,
            body: {
              ProductionAccessEnabled: true,
              SendingEnabled: true,
              SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 12 },
            },
          },
        },
      ],
      badKey: [
        {
          label: "GetAccount with a wrong key",
          method: "GET",
          url: `${SES_FIXTURE_API}/v2/email/account`,
          response: {
            status: 403,
            headers: { "x-amzn-errortype": "InvalidSignatureException" },
            body: { message: "The request signature we calculated does not match." },
          },
        },
      ],
    },
    webhook: {
      secret: SES_FIXTURE_TOPIC,
      wrongSecret: "arn:aws:sns:us-east-1:210987654321:someone-else",
      sign: (input) => signSesWebhook(input),
      staleAt: NOW - 2 * 60 * 60 * 1000,
      tamper(body) {
        const value = JSON.parse(decoder.decode(body)) as SnsMessage;
        return encoder.encode(JSON.stringify({ ...value, Message: `${value.Message} ` }));
      },
      exchanges: [
        {
          label: "the SNS signing certificate",
          method: "GET",
          url: SES_FIXTURE_CERT_URL,
          response: () =>
            signer
              ? { status: 200, body: signer.certificatePem }
              : { status: 404, body: "Not found" },
        },
      ],
      samples: [
        {
          label: "a permanent bounce",
          body: sesNotification({
            eventType: "Bounce",
            bounce: {
              bounceType: "Permanent",
              bounceSubType: "General",
              timestamp: "2026-10-26T12:00:00.000Z",
              bouncedRecipients: [{ emailAddress: "ana@example.org" }],
            },
          }),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              recipient: "ana@example.org",
              providerMessageId: SES_FIXTURE_MESSAGE_ID,
              occurredAt: Date.parse("2026-10-26T12:00:00.000Z"),
              eventKey: SES_FIXTURE_SNS_ID,
              rawType: "Bounce",
              provider: "ses",
            },
          ],
        },
        {
          label: "a transient bounce of two recipients",
          body: sesNotification(
            {
              eventType: "Bounce",
              bounce: {
                bounceType: "Transient",
                bouncedRecipients: [
                  { emailAddress: "ana@example.org" },
                  { emailAddress: "bo@example.org" },
                ],
              },
            },
            "1b2c3d4e-0000-5000-8000-000000000002",
          ),
          expected: [
            {
              type: "bounced",
              bounce: "soft",
              recipient: "ana@example.org",
              eventKey: "1b2c3d4e-0000-5000-8000-000000000002",
            },
            {
              type: "bounced",
              bounce: "soft",
              recipient: "bo@example.org",
              eventKey: "1b2c3d4e-0000-5000-8000-000000000002:1",
            },
          ],
        },
        {
          label: "a complaint",
          body: sesNotification(
            {
              eventType: "Complaint",
              complaint: {
                complaintFeedbackType: "abuse",
                timestamp: "2026-10-26T12:00:01.000Z",
                complainedRecipients: [{ emailAddress: "ana@example.org" }],
              },
            },
            "1b2c3d4e-0000-5000-8000-000000000003",
          ),
          expected: [{ type: "complained", recipient: "ana@example.org", rawType: "Complaint" }],
        },
        {
          label: "a delivery from an identity notification",
          body: sesNotification(
            {
              notificationType: "Delivery",
              delivery: {
                timestamp: "2026-10-26T12:00:02.000Z",
                recipients: ["ana@example.org"],
              },
            },
            "1b2c3d4e-0000-5000-8000-000000000004",
          ),
          expected: [{ type: "delivered", recipient: "ana@example.org", rawType: "Delivery" }],
        },
        {
          label: "an event type that mailswitch does not map",
          body: sesNotification({ eventType: "Open" }, "1b2c3d4e-0000-5000-8000-000000000005"),
          expected: [{ type: "unknown", rawType: "Open" }],
        },
        {
          label: "a subscription confirmation",
          body: snsEnvelope({
            Type: "SubscriptionConfirmation",
            MessageId: "1b2c3d4e-0000-5000-8000-000000000006",
            Token: "2336412f37fb687f5d51e6e2425c464de12884",
            Message: "You have chosen to subscribe to the topic.",
            SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(SES_FIXTURE_TOPIC)}&Token=2336412f37fb687f5d51e6e2425c464de12884`,
          }),
          expected: [{ type: "unknown", rawType: "SubscriptionConfirmation" }],
        },
      ],
    },
    canary(field, token) {
      if (field.name === "region") return `us-${token}-1`;
      if (field.name === "accessKeyId") return `AKIA${token}`;
      return token;
    },
  };
}
