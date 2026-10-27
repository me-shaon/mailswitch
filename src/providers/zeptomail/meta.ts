// ZeptoMail provider data. Pure data: the catalog imports this file without the adapter.
// ZeptoMail is now part of Zoho CPaaS. The API keys and the api.zeptomail.* hosts stay the
// same. Checked 2026-10-27.
// https://www.zoho.com/zeptomail/help/api/email-sending.html
// https://www.zoho.com/zeptomail/help/api/error-codes.html
// https://www.zoho.com/blog/cpaas/zeptomail-is-now-zoho-cpaas.html

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const zeptomailMeta: ProviderMeta = defineProviderMeta({
  id: "zeptomail",
  name: "ZeptoMail",
  // Tier 2: send, attachments, and verify. ZeptoMail webhooks are deferred.
  tier: 2,
  capabilities: {
    attachments: true,
    // 15 MB for one email with its attachments. mailswitch checks it after encoding.
    maxMessageBytes: 15_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // ZeptoMail accepts no idempotency key.
    idempotency: false,
    // ZeptoMail has no batch of distinct messages.
    batchSize: 1,
    // Each of To, Cc, and Bcc takes at most 500 addresses. 500 in total is the safe side.
    maxRecipients: 500,
  },
  credentialFields: [
    {
      name: "token",
      label: "Send Mail token",
      secret: true,
      required: true,
      placeholder: "Zoho-enczapikey ...",
      // ZeptoMail does not document the token format. A pasted prefix is allowed.
      pattern: "^(Zoho-enczapikey\\s+)?\\S{8,}$",
      hint: "The Send Mail token of a Mail Agent, under Mail Agents, SMTP/API. The Zoho-enczapikey prefix is optional.",
    },
    {
      name: "region",
      label: "Region",
      secret: false,
      required: false,
      defaultValue: "com",
      options: [
        { value: "com", label: "US (api.zeptomail.com)" },
        { value: "eu", label: "EU (api.zeptomail.eu)" },
        { value: "in", label: "India (api.zeptomail.in)" },
        { value: "com.au", label: "Australia (api.zeptomail.com.au)" },
        { value: "jp", label: "Japan (api.zeptomail.jp)" },
        { value: "ca", label: "Canada (api.zeptomail.ca)" },
        { value: "sa", label: "Saudi Arabia (api.zeptomail.sa)" },
      ],
      pattern: "^(com|eu|in|com\\.au|jp|ca|sa)$",
      hint: "The data center of the ZeptoMail account. It is the domain of the account URL.",
    },
    {
      name: "fromAddress",
      label: "Verify sender",
      secret: false,
      required: false,
      placeholder: "noreply@example.com",
      pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      hint: "Optional. An address of a verified domain. The credential check uses it as the sender. It sends no email.",
    },
  ],
  docsUrl: "https://www.zoho.com/zeptomail/help/api/email-sending.html",
  // Tier 2 keeps the default table. Every 5xx stays unknown. The adapter refines a 4xx
  // reason from the error code in the body.
  statusMap: defineStatusMap({}),
  webhooks: false,
  nativeIdempotency: false,
});
