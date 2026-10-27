// Mailjet provider data. Pure data: the catalog imports this file without the adapter.
// Checked 2026-10-27.
// https://dev.mailjet.com/openapi/openapi-mailjet/send-emails/postsendv31.md
// https://dev.mailjet.com/docs/email-api/send-api-v31/send-api-errors.md
// https://dev.mailjet.com/docs/email-api/webhooks/webhooks-overview.md
// https://dev.mailjet.com/docs/email-api/webhooks/event-types.md

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

// Mailjet API keys and secret keys are 32 hex characters. Mailjet documents no format,
// so the pattern checks only the character set and the length.
const KEY_PATTERN = "^[A-Za-z0-9]{20,64}$";

export const mailjetMeta: ProviderMeta = defineProviderMeta({
  id: "mailjet",
  name: "Mailjet",
  tier: 1,
  capabilities: {
    attachments: true,
    // "The total API call payload ... should not exceed 15 MB", with attachments and
    // inline attachments. The adapter also checks the size of each request body.
    maxMessageBytes: 15_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // CustomID is only a tag. Mailjet accepts no idempotency key.
    idempotency: false,
    // "Send API v3.1 allows you to send up to 50 messages in a single API call." Each
    // message gets its own entry in the response.
    batchSize: 50,
    // Mailjet has a recipient limit (send-0015) but does not give the number. 50 is a
    // safe guess.
    maxRecipients: 50,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      pattern: KEY_PATTERN,
      hint: "The API key from Account settings, REST API, API key management.",
    },
    {
      name: "secretKey",
      label: "Secret key",
      secret: true,
      required: true,
      pattern: KEY_PATTERN,
      hint: "The secret key of the same API key. Mailjet shows it only once.",
    },
  ],
  docsUrl: "https://dev.mailjet.com/openapi/openapi-mailjet/send-emails/postsendv31.md",
  // The default table matches the documented 400, 401, and 403 answers. A 429 has no
  // documented Retry-After header. Every 5xx stays unknown: no Mailjet document says
  // that a 5xx sent nothing.
  statusMap: defineStatusMap({}),
  webhooks: true,
  nativeIdempotency: false,
});
