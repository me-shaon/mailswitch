// The conformance fixture of the SendGrid adapter. The exchanges and the webhook bodies
// follow the examples of the SendGrid API reference (checked 2026-10-27). SendGrid has no
// free test account, so every body here comes from the reference. The ids, keys, and
// addresses are made up.
// https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
// https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access
// https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event
// https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
//
// The webhook keys are two P-256 key pairs that the module makes when it loads. The
// fixture function is synchronous and the secret must be known when it returns, so the
// keys are made by a top-level await and not inside the function. They protect nothing.

import { bytesToBase64 } from "../../internal/encoding";
import {
  SENDGRID_API_BASE,
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
  sendgridSignedPayload,
} from "../../providers/sendgrid/index";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-27T12:00:30.000Z");
const MESSAGE_ID = "W4bXK2lzRz-9fI0sJ3a1Rg";
const SG_MESSAGE_ID = `${MESSAGE_ID}.filterdrecv-5bd8cbd9f8-abcde-1-6719F2A6-1.0`;

/** Makes one P-256 key pair, with its public key as a base64 SubjectPublicKeyInfo. */
async function keyPair(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer;
  return { publicKey: bytesToBase64(new Uint8Array(spki)), privateKey: pair.privateKey };
}

const FIXTURE_PAIR = await keyPair();
const OTHER_PAIR = await keyPair();

/** The public key of the fixture: a base64 SubjectPublicKeyInfo, as the console shows it. */
export const SENDGRID_FIXTURE_PUBLIC_KEY: string = FIXTURE_PAIR.publicKey;
/** The public key of a second key pair. Its signatures do not match the fixture key. */
export const SENDGRID_FIXTURE_OTHER_PUBLIC_KEY: string = OTHER_PAIR.publicKey;

/** The DER form of one 32-byte integer: no leading zero bytes, and a 0x00 when the top bit is set. */
function derInteger(bytes: Uint8Array): number[] {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const out = [...bytes.subarray(start)];
  if ((out[0] as number) & 0x80) out.unshift(0);
  return [0x02, out.length, ...out];
}

/** Converts a raw `r||s` signature, as Web Crypto makes it, to DER, as SendGrid sends it. */
export function rawToDerSignature(raw: Uint8Array): Uint8Array {
  const body = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32, 64))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

function privateKeyOf(publicKey: string): CryptoKey {
  return publicKey === OTHER_PAIR.publicKey ? OTHER_PAIR.privateKey : FIXTURE_PAIR.privateKey;
}

/**
 * Signs a body the way SendGrid does, at time `at`. `secret` is the public key of one of
 * the two fixture key pairs. Any other value signs with the fixture key.
 */
export async function signSendgridWebhook(input: {
  body: Uint8Array;
  secret: string;
  at: number;
}): Promise<WebhookSample> {
  const timestamp = String(Math.floor(input.at / 1000));
  const raw = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKeyOf(input.secret),
    sendgridSignedPayload(timestamp, input.body),
  );
  return {
    headers: new Headers({
      [SENDGRID_SIGNATURE_HEADER]: bytesToBase64(rawToDerSignature(new Uint8Array(raw))),
      [SENDGRID_TIMESTAMP_HEADER]: timestamp,
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

/** One SendGrid event, with the fields of the Event Webhook reference. */
export function sendgridEvent(
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email: "ana@example.org",
    timestamp: 1793102340,
    "smtp-id": `<${MESSAGE_ID}@example.com>`,
    event,
    category: ["invoice"],
    sg_event_id: `sg-${event}-0001`,
    sg_message_id: SG_MESSAGE_ID,
    ...fields,
  };
}

interface SentBody {
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string }[];
}

const SEND_ERROR = (message: string, field: string | null) => ({
  errors: [{ message, field, help: null }],
});

/** The fixture that drives `sendgrid()` through every conformance check. */
export function sendgridFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: "SG.test-sendgrid-key-not-real" },
    now: NOW,
    send: {
      request: { method: "POST", url: `${SENDGRID_API_BASE}/v3/mail/send` },
      success: { status: 202, headers: { "x-message-id": MESSAGE_ID }, body: "" },
      providerMessageId: MESSAGE_ID,
      authFailure: {
        status: 401,
        body: SEND_ERROR("The provided authorization grant is invalid, expired, or revoked", null),
      },
      validationFailure: {
        status: 400,
        body: SEND_ERROR("Does not contain a valid address.", "personalizations.0.to.0.email"),
      },
      serverError: { status: 500, body: SEND_ERROR("Internal server error", null) },
      // SendGrid sends the reset time in Unix seconds, and no Retry-After.
      rateLimited: {
        status: 429,
        headers: {
          "x-ratelimit-limit": "600",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 2),
        },
        body: SEND_ERROR("too many requests", null),
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
          label: "GET /v3/scopes with a Mail Send key",
          method: "GET",
          url: `${SENDGRID_API_BASE}/v3/scopes`,
          response: { status: 200, body: { scopes: ["mail.send", "user.profile.read"] } },
        },
      ],
      badKey: [
        {
          label: "GET /v3/scopes with a wrong key",
          method: "GET",
          url: `${SENDGRID_API_BASE}/v3/scopes`,
          response: {
            status: 401,
            body: SEND_ERROR("authorization required", null),
          },
        },
      ],
    },
    canary: (_field, token) => `SG.${token}`,
    webhook: {
      secret: SENDGRID_FIXTURE_PUBLIC_KEY,
      wrongSecret: SENDGRID_FIXTURE_OTHER_PUBLIC_KEY,
      sign: signSendgridWebhook,
      // Six minutes before the fixed clock, outside the 5-minute window.
      staleAt: NOW - 6 * 60 * 1000,
      samples: [
        {
          label: "four events in one body",
          body: JSON.stringify([
            sendgridEvent("delivered", { response: "250 OK" }),
            sendgridEvent("bounce", {
              type: "bounce",
              status: "5.0.0",
              reason: "500 unknown recipient",
              bounce_classification: "Invalid Address",
            }),
            sendgridEvent("bounce", {
              email: "bo@example.org",
              sg_event_id: "sg-blocked-0002",
              type: "blocked",
              status: "4.0.0",
              reason: "451 try again later",
            }),
            sendgridEvent("spamreport"),
          ]),
          expected: [
            {
              type: "delivered",
              rawType: "delivered",
              recipient: "ana@example.org",
              providerMessageId: SG_MESSAGE_ID,
              eventKey: "sg-delivered-0001",
              occurredAt: 1793102340000,
            },
            {
              type: "bounced",
              bounce: "hard",
              rawType: "bounce",
              recipient: "ana@example.org",
              eventKey: "sg-bounce-0001",
            },
            {
              type: "bounced",
              bounce: "soft",
              rawType: "bounce",
              recipient: "bo@example.org",
              eventKey: "sg-blocked-0002",
            },
            { type: "complained", rawType: "spamreport", eventKey: "sg-spamreport-0001" },
          ],
        },
        {
          label: "an event that mailswitch does not map",
          body: JSON.stringify([sendgridEvent("open", { useragent: "Mozilla/5.0" })]),
          expected: [{ type: "unknown", rawType: "open", eventKey: "sg-open-0001" }],
        },
      ],
    },
  };
}
