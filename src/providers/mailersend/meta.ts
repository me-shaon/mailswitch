// MailerSend provider data. Pure data: the catalog imports this file without the adapter.
// Checked 2026-10-27.
// https://developers.mailersend.com/api/v1/email
// https://developers.mailersend.com/general
// https://developers.mailersend.com/guides/checking-api-quota
// https://developers.mailersend.com/api/v1/account/webhooks

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

const GENERAL = "https://developers.mailersend.com/general";

export const mailersendMeta: ProviderMeta = defineProviderMeta({
  id: "mailersend",
  name: "MailerSend",
  tier: 1,
  capabilities: {
    attachments: true,
    // "max 25MB after decoding" for one attachment. MailerSend gives no total for one
    // message. mailswitch checks the whole message after base64 encoding, which is the
    // safe side.
    maxMessageBytes: 25_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    // Custom headers need the Professional plan or higher. A lower plan gets a 422.
    customHeaders: true,
    // MailerSend accepts no idempotency key. The mailer store gives the only protection.
    idempotency: false,
    // The bulk endpoint is asynchronous and gives no per-message result, so the core
    // sends one message at a time.
    batchSize: 1,
    // 50 To, 10 Cc, and 10 Bcc. The adapter also checks each field.
    maxRecipients: 70,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API token",
      secret: true,
      required: true,
      placeholder: "mlsn.xxxxxxxx",
      // MailerSend documents no token format. New tokens start with "mlsn.", and older
      // tokens are longer, so the pattern checks only the character set and the length.
      pattern: "^[A-Za-z0-9._-]{20,2048}$",
      hint: "An API token with the Email full access permission. MailerSend shows the token only once.",
    },
  ],
  docsUrl: "https://developers.mailersend.com/api/v1/email",
  // The default table matches 400, 401, 403, 404, 405, 422, and 429. MailerSend documents
  // 408 as "an error occurred on our system" and 421 as maintenance. Both are faults on its
  // side with no statement that the message did not go out, so they are unknown. Every
  // 5xx stays unknown.
  statusMap: defineStatusMap({
    408: { status: "unknown", reason: "provider_error", source: GENERAL },
    421: { status: "unknown", reason: "provider_error", source: GENERAL },
  }),
  webhooks: true,
  webhookSecret: {
    label: "Signing secret",
    source: "provider",
    hint: "The signing secret of the webhook in MailerSend. Open the webhook after you save it.",
  },
  nativeIdempotency: false,
});
