// Brevo provider data. Pure data: the catalog imports this file without the adapter.
// Checked 2026-10-27.
// https://developers.brevo.com/reference/sendtransacemail
// https://developers.brevo.com/docs/how-it-works
// https://developers.brevo.com/docs/heterogenous-versions-batch-emails
// https://developers.brevo.com/docs/limit-headers

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const brevoMeta: ProviderMeta = defineProviderMeta({
  id: "brevo",
  name: "Brevo",
  tier: 1,
  capabilities: {
    attachments: true,
    // Brevo limits one transactional email to 20 MB, attachments included. mailswitch
    // checks the size after base64 encoding, which is the safe side.
    maxMessageBytes: 20_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    // Brevo passes custom headers, but it writes each header name in Title-Case.
    customHeaders: true,
    // A UUID `idempotencyKey` in the body `headers` object. Brevo keeps it for 30 minutes.
    // https://developers.brevo.com/docs/heterogenous-versions-batch-emails
    idempotency: true,
    // A Brevo `messageVersions` batch shares the sender and the attachments, so the core
    // sends one message at a time.
    batchSize: 1,
    // "Maximum recipients per message version is 99."
    maxRecipients: 99,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "xkeysib-...",
      // Brevo documents no exact key format. Every v3 API key starts with "xkeysib-".
      pattern: "^xkeysib-[A-Za-z0-9-]{16,200}$",
      hint: "A v3 API key from the SMTP & API page of Brevo. Turn off authorized IPs for this key.",
    },
  ],
  docsUrl: "https://developers.brevo.com/reference/sendtransacemail",
  // The default table matches the documented answers: 400 is invalid_message, 401 and
  // 403 are auth, 402 is credits, and 429 is rate_limited. The adapter refines a 400
  // from the body code. Brevo documents no 5xx, so every 5xx stays unknown.
  statusMap: defineStatusMap({}),
  webhooks: true,
  webhookSecret: {
    label: "Webhook token",
    source: "generated",
    hint: "Make it with generateBrevoWebhookToken(). Set it as the bearer token of the Brevo webhook.",
  },
  nativeIdempotency: true,
  // "The TTL for idempotencyKey is 30 minutes."
  nativeIdempotencyWindowMs: 1_800_000,
});
