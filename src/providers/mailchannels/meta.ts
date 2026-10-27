// MailChannels Email API provider data. Pure data: the catalog imports this file without
// the adapter. Checked 2026-10-27.
// https://docs.mailchannels.com/api-reference/send/send-an-email
// https://docs.mailchannels.com/email-api/errors
// https://docs.mailchannels.com/api-reference/usage/retrieve-usage-stats
// https://docs.mailchannels.com/email-api/webhooks

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const mailchannelsMeta: ProviderMeta = defineProviderMeta({
  id: "mailchannels",
  name: "MailChannels",
  tier: 1,
  capabilities: {
    attachments: true,
    // "The encoded message, headers, and attachments exceed 30 MB" gives 413.
    maxMessageBytes: 30_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // MailChannels accepts no idempotency key. The mailer store gives the only protection.
    idempotency: false,
    // The personalizations of one request share one body, so they are not a batch of
    // distinct messages. The core sends one message at a time.
    batchSize: 1,
    // One personalization takes at most 1000 To recipients, and 1000 each for Cc and
    // Bcc. mailswitch uses 1000 across all three, which is the safe side.
    maxRecipients: 1000,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      // MailChannels documents no key format. The pattern checks only printable ASCII
      // with no space, and the length.
      pattern: "^[\\x21-\\x7e]{8,512}$",
      hint: "An API key from the MailChannels console. The sending domain needs a Domain Lockdown TXT record.",
    },
  ],
  docsUrl: "https://docs.mailchannels.com/api-reference/send/send-an-email",
  // The default table matches the documented answers: 400 and 413 are invalid_message,
  // and 403 (a bad key, a wrong scope, or a domain that is not authorized) is auth.
  // MailChannels calls 500 and 502 transient, with no statement that the message did not
  // go out, so every 5xx stays unknown. 429 is not documented and keeps the default.
  statusMap: defineStatusMap({}),
  webhooks: true,
  webhookSecret: {
    label: "Webhook public key",
    source: "provider",
    hint: "The MailChannels public key for the keyid of your webhooks, as base64 or a PEM block.",
  },
  nativeIdempotency: false,
});
