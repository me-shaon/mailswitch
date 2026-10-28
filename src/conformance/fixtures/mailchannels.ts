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
// The webhook keys are two fixed Ed25519 key pairs, made once for tests. They protect
// nothing. The sign helper imports a private key on its first call.

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
import { importPrivateKey } from "./private-keys";

const NOW = Date.parse("2026-10-27T12:00:30.000Z");
const MESSAGE_ID = "mc-message-0001";
const REQUEST_ID = "mc-request-0001";

/**
 * The public key of the fixture: a base64 SubjectPublicKeyInfo.
 * For tests only. Never use it in production config.
 */
export const MAILCHANNELS_FIXTURE_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAsVNKmTiPGI0tgSii8QwJicAjgOJGOd8+VIN14oOE9wo=";
/**
 * The public key of a second key pair. Its signatures do not match the fixture key.
 * For tests only. Never use it in production config.
 */
export const MAILCHANNELS_FIXTURE_OTHER_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAlGHpqE6tJ9T0svYhzzLsObt8rKBKfYTDkXN3SnstLgo=";

// The PKCS #8 private keys of the two pairs. Test-only values that protect nothing.
const FIXTURE_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIJ7LELDYV+fs8DqakGIXZ0R29VfFv2MfnIVonXCFANGJ";
const OTHER_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIBEpfeLBiZ5jwEcvzwlXycBEwSYH+i+NJl5RoT/rgSNK";

function privateKeyOf(publicKey: string): Promise<CryptoKey> {
  return importPrivateKey(
    publicKey === MAILCHANNELS_FIXTURE_OTHER_PUBLIC_KEY ? OTHER_PRIVATE_KEY : FIXTURE_PRIVATE_KEY,
    { name: "Ed25519" },
  );
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
    await privateKeyOf(input.secret),
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

/** The made-up customer handle of the fixture account. Pass it as `customerHandle`. */
export const MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE = "test-handle-not-real";

/** One MailChannels event, with the fields of the webhook schema. */
export function mailchannelsEvent(
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email: "billing@example.com",
    customer_handle: MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE,
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

/**
 * The fixture that drives `mailchannels({ customerHandle })` through every conformance
 * check, with `MAILCHANNELS_FIXTURE_CUSTOMER_HANDLE` as the handle.
 */
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
              bounceDetail: { text: "550 unknown recipient", enhancedCode: "5.1.1" },
              recipient: "ana@example.org",
              eventKey: `${REQUEST_ID}:hard-bounced:ana@example.org:1793102340:`,
            },
            {
              type: "bounced",
              bounce: "soft",
              rawType: "soft-bounced",
              bounceDetail: { text: "452 mailbox full", enhancedCode: "4.2.2" },
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
          label: "unsubscribe",
          // The provider docs do not confirm the shape of this payload.
          body: JSON.stringify([
            mailchannelsEvent("unsubscribed", { recipients: ["cy@example.org"] }),
          ]),
          expected: [
            {
              type: "unsubscribed",
              rawType: "unsubscribed",
              recipient: "cy@example.org",
              eventKey: `${REQUEST_ID}:unsubscribed:cy@example.org:1793102340:`,
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
