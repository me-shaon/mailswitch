// SendGrid provider data. Pure data: the catalog imports this file without the adapter.
// Checked 2026-10-27.
// https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
// https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/rate-limits
// https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const sendgridMeta: ProviderMeta = defineProviderMeta({
  id: "sendgrid",
  name: "SendGrid",
  tier: 1,
  capabilities: {
    attachments: true,
    // SendGrid pages give 20 MB and 30 MB for one message, and the Mail Send reference
    // gives no total. mailswitch uses the lower value, 20 MB, and checks the size after
    // base64 encoding, which is the safe side. A larger request gets 413.
    maxMessageBytes: 20_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // SendGrid accepts no idempotency key. The mailer store gives the only protection.
    idempotency: false,
    // SendGrid has no batch of distinct messages, so the core sends one at a time.
    batchSize: 1,
    // 1000 recipients across To, Cc, and Bcc of one personalization.
    maxRecipients: 1000,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "SG.xxxxxxxx",
      // SendGrid documents no exact key format. Every key starts with "SG.".
      pattern: "^SG\\.[A-Za-z0-9_.-]{20,200}$",
      hint: "An API key with the Mail Send permission. SendGrid shows the key only once.",
    },
  ],
  docsUrl: "https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send",
  // The default table matches the documented answers: 400 and 413 are invalid_message,
  // 401 and 403 are auth, and 429 is rate_limited. SendGrid documents a 500 with no
  // statement that the message did not go out, so every 5xx stays unknown.
  statusMap: defineStatusMap({}),
  webhooks: true,
  nativeIdempotency: false,
});
