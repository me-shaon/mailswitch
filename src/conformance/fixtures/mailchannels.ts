// The conformance fixture of the MailChannels adapter. The exchanges and the webhook
// bodies follow the examples and the schemas of the MailChannels docs (checked
// 2026-10-27). No answer here is a recording from a live account. The ids, keys, and
// addresses are made up.
// https://docs.mailchannels.com/api-reference/send/send-an-email
// https://docs.mailchannels.com/email-api/errors
// https://docs.mailchannels.com/api-reference/usage/retrieve-usage-stats
// https://docs.mailchannels.com/email-api/webhooks
// https://docs.mailchannels.com/email-api/webhook-schema
//
// The webhook keys are two Ed25519 key pairs that the module makes when it loads. The
// fixture function is synchronous and the secret must be known when it returns, so the
// keys are made by a top-level await and not inside the function. They protect nothing.

import { bytesToBase64 } from "../../internal/encoding";
import {
  MAILCHANNELS_API_BASE,
  MAILCHANNELS_DIGEST_HEADER,
  MAILCHANNELS_SIGNATURE_HEADER,
  MAILCHANNELS_SIGNATURE_INPUT_HEADER,
  mailchannelsContentDigest,
  mailchannelsSignatureBase,
} from "../../providers/mailchannels/index";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-27T12:00:30.000Z");
const MESSAGE_ID = "mc-message-0001";
const REQUEST_ID = "mc-request-0001";

/** Makes one Ed25519 key pair, with its public key as a base64 SubjectPublicKeyInfo. */
async function keyPair(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer;
  return { publicKey: bytesToBase64(new Uint8Array(spki)), privateKey: pair.privateKey };
}

const FIXTURE_PAIR = await keyPair();
const OTHER_PAIR = await keyPair();

/** The public key of the fixture: a base64 SubjectPublicKeyInfo. */
export const MAILCHANNELS_FIXTURE_PUBLIC_KEY: string = FIXTURE_PAIR.publicKey;
/** The public key of a second key pair. Its signatures do not match the fixture key. */
export const MAILCHANNELS_FIXTURE_OTHER_PUBLIC_KEY: string = OTHER_PAIR.publicKey;

function privateKeyOf(publicKey: string): CryptoKey {
  return publicKey === OTHER_PAIR.publicKey ? OTHER_PAIR.privateKey : FIXTURE_PAIR.privateKey;
}

/** Options of `signMailchannelsWebhook`, to build broken requests in tests. */
export interface MailchannelsSignOptions {
  /** The signature label. Defaults to `sig_1`. */
  label?: string;
  /** The label in the `Signature` header. Defaults to `label`. */
  signatureLabel?: string;
  /** The covered components. Defaults to `("content-digest")`. */
  components?: string;
  /** The parameters after `created`. Defaults to `;alg="ed25519";keyid="mckey"`. */
  params?: string;
}

/**
 * Signs a body the way MailChannels does, at time `at`. `secret` is the public key of one
 * of the two fixture key pairs. Any other value signs with the fixture key.
 */
export async function signMailchannelsWebhook(
  input: { body: Uint8Array; secret: string; at: number },
  options: MailchannelsSignOptions = {},
): Promise<WebhookSample> {
  const label = options.label ?? "sig_1";
  const created = Math.floor(input.at / 1000);
  const params = `${options.components ?? '("content-digest")'};created=${created}${
    options.params ?? ';alg="ed25519";keyid="mckey"'
  }`;
  const digest = await mailchannelsContentDigest(input.body);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKeyOf(input.secret),
    mailchannelsSignatureBase(digest, params) as Uint8Array<ArrayBuffer>,
  );
  return {
    headers: new Headers({
      [MAILCHANNELS_DIGEST_HEADER]: digest,
      [MAILCHANNELS_SIGNATURE_INPUT_HEADER]: `${label}=${params}`,
      [MAILCHANNELS_SIGNATURE_HEADER]: `${options.signatureLabel ?? label}=:${bytesToBase64(new Uint8Array(signature))}:`,
      "content-type": "application/json",
    }),
    body: input.body,
  };
}

/** One MailChannels event, with the fields of the webhook schema. */
export function mailchannelsEvent(
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email: "billing@example.com",
    customer_handle: "acct-test",
    timestamp: 1793102340,
    event,
    request_id: REQUEST_ID,
    recipients: ["ana@example.org"],
    ...fields,
  };
}

interface SentBody {
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string }[];
}

/** The 202 answer of one accepted personalization. */
export function mailchannelsAccepted(
  results: { status: string; message_id?: string; reason?: string }[] = [
    { status: "sent", message_id: MESSAGE_ID, reason: "" },
  ],
): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    results: results.map((item, index) => ({ index, ...item })),
  };
}

/** The fixture that drives `mailchannels()` through every conformance check. */
export function mailchannelsFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: "test-mailchannels-key-not-real" },
    now: NOW,
    send: {
      request: { method: "POST", url: `${MAILCHANNELS_API_BASE}/tx/v1/send` },
      success: { status: 202, body: mailchannelsAccepted() },
      providerMessageId: MESSAGE_ID,
      // A bad key is 403, as the errors page states.
      authFailure: { status: 403, body: { errors: ["Forbidden"] } },
      validationFailure: {
        status: 400,
        body: { errors: ["personalizations[0].to[0].email: invalid email address"] },
      },
      serverError: { status: 500, body: { errors: ["Internal Server Error"] } },
      // MailChannels documents no 429. The default throttle answer of the kit applies.
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
          label: "GET /tx/v1/usage with a good key",
          method: "GET",
          url: `${MAILCHANNELS_API_BASE}/tx/v1/usage`,
          response: { status: 200, body: { period_start_date: "2026-10-01", usage: 12 } },
        },
      ],
      badKey: [
        {
          label: "GET /tx/v1/usage with a wrong key",
          method: "GET",
          url: `${MAILCHANNELS_API_BASE}/tx/v1/usage`,
          response: { status: 403, body: { errors: ["Forbidden"] } },
        },
      ],
    },
    webhook: {
      secret: MAILCHANNELS_FIXTURE_PUBLIC_KEY,
      wrongSecret: MAILCHANNELS_FIXTURE_OTHER_PUBLIC_KEY,
      sign: (input) => signMailchannelsWebhook(input),
      // Six minutes before the fixed clock, outside the 5-minute window.
      staleAt: NOW - 6 * 60 * 1000,
      samples: [
        {
          label: "four events in one body",
          body: JSON.stringify([
            mailchannelsEvent("delivered"),
            mailchannelsEvent("hard-bounced", {
              status: "5.1.1",
              reason: "550 unknown recipient",
            }),
            mailchannelsEvent("soft-bounced", {
              recipients: ["bo@example.org"],
              status: "4.2.2",
              reason: "452 mailbox full",
            }),
            mailchannelsEvent("complained", { timestamp: 1793102400 }),
          ]),
          expected: [
            {
              type: "delivered",
              rawType: "delivered",
              recipient: "ana@example.org",
              eventKey: `${REQUEST_ID}:delivered:ana@example.org:1793102340:`,
              occurredAt: 1793102340000,
            },
            {
              type: "bounced",
              bounce: "hard",
              rawType: "hard-bounced",
              recipient: "ana@example.org",
              eventKey: `${REQUEST_ID}:hard-bounced:ana@example.org:1793102340:`,
            },
            {
              type: "bounced",
              bounce: "soft",
              rawType: "soft-bounced",
              recipient: "bo@example.org",
              eventKey: `${REQUEST_ID}:soft-bounced:bo@example.org:1793102340:`,
            },
            {
              type: "complained",
              rawType: "complained",
              eventKey: `${REQUEST_ID}:complained:ana@example.org:1793102400:`,
            },
          ],
        },
        {
          label: "events that mailswitch does not map",
          body: JSON.stringify([
            mailchannelsEvent("processed"),
            mailchannelsEvent("click", { url: "https://example.com/a" }),
          ]),
          expected: [
            { type: "unknown", rawType: "processed" },
            {
              type: "unknown",
              rawType: "click",
              eventKey: `${REQUEST_ID}:click:ana@example.org:1793102340:https://example.com/a`,
            },
          ],
        },
      ],
    },
  };
}
