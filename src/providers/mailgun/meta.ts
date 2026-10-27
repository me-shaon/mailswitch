// Mailgun provider data. Pure data: the catalog imports this file without the adapter.

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

const ERRORS_DOCS = "https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview";

export const mailgunMeta: ProviderMeta = defineProviderMeta({
  id: "mailgun",
  name: "Mailgun",
  tier: 1,
  capabilities: {
    attachments: true,
    // 25 MB per message, including attachments. mailswitch checks it after encoding.
    maxMessageBytes: 25_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    idempotency: false,
    // The adapter sends one message per request. Mailgun batches use recipient variables.
    batchSize: 1,
    // At most 1,000 recipients per message.
    maxRecipients: 1000,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      hint: "A Mailgun API key or a domain sending key.",
    },
    {
      name: "domain",
      label: "Sending domain",
      secret: false,
      required: true,
      placeholder: "mg.example.com",
      hint: "The domain as Mailgun lists it under Domains.",
      pattern: "^([A-Za-z0-9-]+\\.)+[A-Za-z]{2,63}$",
    },
    {
      name: "region",
      label: "Region",
      secret: false,
      required: false,
      defaultValue: "us",
      options: [
        { value: "us", label: "US (api.mailgun.net)" },
        { value: "eu", label: "EU (api.eu.mailgun.net)" },
      ],
      hint: "The region of the domain. A domain in the EU region uses the EU API.",
      pattern: "^(us|eu)$",
    },
  ],
  docsUrl: "https://documentation.mailgun.com/docs/mailgun/api-reference/",
  statusMap: defineStatusMap({
    // "Request Failed: the parameters were valid but the request failed." Not a credit error.
    402: { status: "not_sent", reason: "rejected", source: ERRORS_DOCS },
    // "Not Found": the domain is not in this account or in this region.
    404: { status: "not_sent", reason: "auth", source: ERRORS_DOCS },
  }),
  webhooks: true,
  webhookSecret: {
    label: "HTTP webhook signing key",
    source: "provider",
    hint: "The HTTP webhook signing key of your Mailgun account. It is not the API key.",
  },
  nativeIdempotency: false,
});
