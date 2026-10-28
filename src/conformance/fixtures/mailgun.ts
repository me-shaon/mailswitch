// The conformance fixture of the Mailgun adapter. The exchanges follow the shapes in
// https://documentation.mailgun.com/docs/mailgun/api-reference/ and the webhook bodies
// follow https://documentation.mailgun.com/docs/mailgun/user-manual/events/ (checked
// 2026-10-26). The ids, keys, and addresses are made up.

import { utf8 } from "../../internal/encoding";
import { sha256Hex } from "../../internal/sha256";
import { MAILGUN_REGIONS, mailgunSignature } from "../../providers/mailgun/index";
import type { CapturedRequest } from "../mock-fetch";
import type { ConformanceFixture, WebhookSample } from "../types";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
const DOMAIN = "mg.example.com";
const MESSAGE_ID = "20261026120030.1.4F2A9C@mg.example.com";
/** A test webhook signing key. For tests only. Never use it in production config. */
export const MAILGUN_FIXTURE_SECRET: string = "mailgun-signing-key-0123456789abcdef";
/** The send URL of the fixture domain in the US region. */
export const MAILGUN_FIXTURE_SEND_URL: string = `${MAILGUN_REGIONS.us}/v3/${DOMAIN}/messages`;

/**
 * Signs an `event-data` body the way Mailgun does. It returns the whole webhook body,
 * `{ "signature": {...}, "event-data": ... }`. The token defaults to a value derived
 * from the body and the time.
 */
export async function signMailgunWebhook(input: {
  body: Uint8Array;
  secret: string;
  at: number;
  token?: string;
}): Promise<WebhookSample> {
  const timestamp = String(Math.floor(input.at / 1000));
  const data = new TextDecoder().decode(input.body);
  const token = input.token ?? sha256Hex(utf8(`${timestamp}.${data}`)).slice(0, 50);
  const signature = await mailgunSignature(input.secret, timestamp, token);
  const body = `{"signature":{"timestamp":"${timestamp}","token":"${token}","signature":"${signature}"},"event-data":${data}}`;
  return { headers: new Headers({ "content-type": "application/json" }), body: utf8(body) };
}

/** A Mailgun `event-data` object as JSON text. */
export function mailgunEvent(
  event: string,
  fields: Record<string, unknown> = {},
  recipient: string = "ana@example.org",
): string {
  return JSON.stringify({
    id: "CPgfbmQMTCKtHW6uIWtuVe",
    timestamp: 1761479998.25,
    "log-level": event === "failed" ? "error" : "info",
    event,
    recipient,
    message: { headers: { "message-id": MESSAGE_ID, to: recipient, subject: "Your invoice" } },
    ...fields,
  });
}

/** One part of a captured multipart body. */
interface Part {
  name: string;
  filename?: string;
  bytes: Uint8Array;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** Splits a captured `multipart/form-data` request into its parts. Byte exact. */
export function readMultipart(request: CapturedRequest): Part[] {
  const type = request.headers.get("content-type") ?? "";
  const boundary = /boundary=([^;]+)/.exec(type)?.[1];
  if (!boundary) return [];
  const text = latin1(request.bytes);
  const parts: Part[] = [];
  for (const chunk of text.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith("--")) break;
    const split = chunk.indexOf("\r\n\r\n");
    const head = chunk.slice(2, split);
    const content = chunk.slice(split + 4, chunk.length - 2);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const bytes = Uint8Array.from(content, (char) => char.charCodeAt(0));
    parts.push(filename === undefined ? { name, bytes } : { name, filename, bytes });
  }
  return parts;
}

function base64(bytes: Uint8Array): string {
  return btoa(latin1(bytes));
}

/** The fixture that drives `mailgun()` through every conformance check. */
export function mailgunFixture(): ConformanceFixture {
  return {
    credentials: { apiKey: "test-mailgun-api-key-not-a-real-secret", domain: DOMAIN, region: "us" },
    now: NOW,
    send: {
      request: { method: "POST", url: MAILGUN_FIXTURE_SEND_URL },
      success: { status: 200, body: { id: `<${MESSAGE_ID}>`, message: "Queued. Thank you." } },
      providerMessageId: MESSAGE_ID,
      authFailure: { status: 401, body: "Forbidden" },
      validationFailure: {
        status: 400,
        body: { message: "'from' parameter is not a valid address. please check documentation" },
      },
      serverError: { status: 500, body: "Internal Server Error" },
      rateLimited: {
        status: 429,
        headers: { "retry-after": "2" },
        body: { message: "Too many requests" },
      },
    },
    readHeaders: (request) =>
      Object.fromEntries(
        readMultipart(request)
          .filter((part) => part.name.startsWith("h:") && part.filename === undefined)
          .map((part) => [part.name.slice(2), new TextDecoder().decode(part.bytes)]),
      ),
    readAttachments: (request) =>
      readMultipart(request)
        .filter((part) => part.name === "attachment" || part.name === "inline")
        .map((part) => ({ filename: part.filename ?? "", content: base64(part.bytes) })),
    verify: {
      ok: [
        {
          label: `GET /v3/domains/${DOMAIN}`,
          method: "GET",
          url: `${MAILGUN_REGIONS.us}/v3/domains/${DOMAIN}`,
          response: {
            status: 200,
            body: { domain: { name: DOMAIN, state: "active", type: "custom" } },
          },
        },
      ],
      badKey: [
        {
          label: `GET /v3/domains/${DOMAIN} with a wrong key`,
          method: "GET",
          url: `${MAILGUN_REGIONS.us}/v3/domains/${DOMAIN}`,
          response: { status: 401, body: "Forbidden" },
        },
      ],
    },
    // The domain must keep the shape of a domain name.
    canary: (field, token) => (field.name === "domain" ? `${token}.example.com` : `key-${token}`),
    webhook: {
      secret: MAILGUN_FIXTURE_SECRET,
      sign: signMailgunWebhook,
      // 6 minutes before the clock. The window allows 5 minutes.
      staleAt: NOW - 6 * 60 * 1000,
      samples: [
        {
          label: "hard bounce",
          body: mailgunEvent("failed", {
            severity: "permanent",
            reason: "bounce",
            "delivery-status": {
              "attempt-no": 1,
              code: 550,
              "enhanced-code": "5.1.1",
              message: "5.1.1 The email account that you tried to reach does not exist.",
              description: "",
              "mx-host": "mx.example.org",
              "session-seconds": 0.4,
            },
          }),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              bounceDetail: {
                text: "5.1.1 The email account that you tried to reach does not exist.",
                smtpCode: 550,
                enhancedCode: "5.1.1",
              },
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "failed",
              occurredAt: 1761479998250,
            },
          ],
        },
        {
          label: "soft bounce",
          body: mailgunEvent(
            "failed",
            {
              severity: "temporary",
              reason: "generic",
              "delivery-status": {
                "attempt-no": 1,
                code: 452,
                "enhanced-code": "4.2.2",
                message: "4.2.2 The email account that you tried to reach is over quota.",
                description: "",
              },
            },
            "bo@example.org",
          ),
          expected: [
            {
              type: "bounced",
              bounce: "soft",
              recipient: "bo@example.org",
              bounceDetail: {
                text: "4.2.2 The email account that you tried to reach is over quota.",
                smtpCode: 452,
                enhancedCode: "4.2.2",
              },
            },
          ],
        },
        {
          label: "delivered",
          body: mailgunEvent("delivered", { "delivery-status": { code: 250, message: "OK" } }),
          expected: [
            {
              type: "delivered",
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "delivered",
            },
          ],
        },
        {
          label: "complaint",
          body: mailgunEvent("complained"),
          expected: [
            {
              type: "complained",
              recipient: "ana@example.org",
              rawType: "complained",
            },
          ],
        },
        {
          label: "a drop after an earlier complaint",
          body: mailgunEvent("failed", { severity: "permanent", reason: "suppress-complaint" }),
          expected: [{ type: "complained", rawType: "failed" }],
        },
        {
          label: "unsubscribe",
          body: mailgunEvent("unsubscribed", {
            ip: "203.0.113.7",
            "client-info": { "client-type": "browser", "user-agent": "Mozilla/5.0" },
          }),
          expected: [
            {
              type: "unsubscribed",
              recipient: "ana@example.org",
              providerMessageId: MESSAGE_ID,
              rawType: "unsubscribed",
            },
          ],
        },
        {
          label: "an event type that mailswitch does not map",
          body: mailgunEvent("opened"),
          expected: [{ type: "unknown", rawType: "opened" }],
        },
      ],
    },
  };
}
