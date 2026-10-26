// The conformance fixture of the SMTP adapter. The kit runs the adapter against the mock
// SMTP server. The replies are Gmail replies, as Google lists them (checked 2026-10-26):
// https://support.google.com/a/answer/3726730
// The Brevo webhook bodies follow the Brevo reference (checked 2026-10-26):
// https://developers.brevo.com/docs/transactional-webhooks
// The hosts, logins, ids, and tokens are made up.

import type { SmtpConformanceFixture } from "../types";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");
/** The Brevo webhook token of the fixture: 32 base64url characters (192 bits). */
export const BREVO_FIXTURE_TOKEN = "YnJldm8tZml4dHVyZS10b2tlbi1vbmx5";
export const BREVO_MESSAGE_ID = "<202610261159.12345678901@smtp-relay.mailin.fr>";

/** A Brevo transactional webhook event. */
export function brevoEvent(
  event: string,
  email: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event,
    email,
    id: 26224,
    date: "2026-10-26 11:59:58",
    ts: 1792929598,
    "message-id": BREVO_MESSAGE_ID,
    ts_event: 1792929598,
    subject: "Your receipt",
    "X-Mailin-custom": "some_custom_header",
    sending_ip: "203.0.113.10",
    ts_epoch: 1792929598123,
    tags: ["transactional"],
    ...extra,
  };
}

const AT = 1792929598123;
const KEY = (event: string, email: string) => `${event}:${BREVO_MESSAGE_ID}:${email}:${AT}`;

/** The fixture that drives `smtp()` through every SMTP conformance check. */
export function smtpFixture(): SmtpConformanceFixture {
  return {
    transport: "smtp",
    credentials: {
      host: "smtp.example.com",
      port: "587",
      security: "starttls",
      username: "sender@example.com",
      password: "fixture-password-1",
    },
    now: NOW,
    server: { username: "sender@example.com", password: "fixture-password-1" },
    replies: {
      authFailure:
        "535-5.7.8 Username and Password not accepted. For more information, go to\r\n535 5.7.8  https://support.google.com/mail/?p=BadCredentials",
      recipientRejected:
        "550-5.1.1 The email account that you tried to reach does not exist. Please try\r\n550-5.1.1 double-checking the recipient's email address for typos or\r\n550 5.1.1 unnecessary spaces. https://support.google.com/mail/?p=NoSuchUser",
      rateLimited: "421 4.7.0 Try again later, closing connection. (MAIL)",
      afterData: "451 4.3.0 Mail server temporarily rejected message.",
    },
    // The mock server answers the first message of a session with this queue id.
    providerMessageId: "M1",
    canaryCredentials: (username, password) => ({
      host: "smtp.example.com",
      port: "587",
      security: "starttls",
      username,
      password,
    }),
    webhook: {
      secret: BREVO_FIXTURE_TOKEN,
      async sign({ body, secret }) {
        return { headers: new Headers({ authorization: `Bearer ${secret}` }), body };
      },
      // A bearer token covers no timestamp.
      staleAt: null,
      // A bearer token covers no body either, so a changed JSON body passes the token
      // check. This tamper breaks the JSON. The dedupe store and HTTPS protect the rest.
      tamper: (body) => body.slice(0, Math.max(1, body.length - 2)),
      samples: [
        {
          label: "hard bounce",
          body: JSON.stringify(
            brevoEvent("hard_bounce", "ana@example.org", { reason: "550 5.1.1 unknown user" }),
          ),
          expected: [
            {
              type: "bounced",
              bounce: "hard",
              recipient: "ana@example.org",
              providerMessageId: BREVO_MESSAGE_ID,
              rawType: "hard_bounce",
              eventKey: KEY("hard_bounce", "ana@example.org"),
              occurredAt: AT,
            },
          ],
        },
        {
          label: "soft bounce",
          body: JSON.stringify(brevoEvent("soft_bounce", "ben@example.org")),
          expected: [{ type: "bounced", bounce: "soft", recipient: "ben@example.org" }],
        },
        {
          label: "invalid email",
          body: JSON.stringify(brevoEvent("invalid_email", "nobody@example.org")),
          expected: [{ type: "bounced", bounce: "hard", rawType: "invalid_email" }],
        },
        {
          label: "delivered",
          body: JSON.stringify(brevoEvent("delivered", "cara@example.org")),
          expected: [{ type: "delivered", recipient: "cara@example.org" }],
        },
        {
          label: "spam complaint",
          body: JSON.stringify(brevoEvent("spam", "dan@example.org")),
          expected: [{ type: "complained", recipient: "dan@example.org" }],
        },
        {
          label: "opened (not mapped)",
          body: JSON.stringify(brevoEvent("opened", "eve@example.org")),
          expected: [{ type: "unknown", rawType: "opened" }],
        },
        {
          label: "two events in one batch",
          body: JSON.stringify([
            brevoEvent("delivered", "fay@example.org"),
            brevoEvent("soft_bounce", "fay@example.org"),
          ]),
          expected: [
            { type: "delivered", eventKey: KEY("delivered", "fay@example.org") },
            { type: "bounced", bounce: "soft", eventKey: KEY("soft_bounce", "fay@example.org") },
          ],
        },
      ],
    },
  };
}
