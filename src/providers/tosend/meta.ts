// toSend provider data. Pure data: the catalog imports this file without the adapter.

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const toSendMeta: ProviderMeta = defineProviderMeta({
  id: "tosend",
  name: "toSend",
  tier: 1,
  capabilities: {
    attachments: true,
    // 10 MB in total. mailswitch checks it after encoding, which is the safe side.
    maxMessageBytes: 10_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    idempotency: false,
    batchSize: 50,
    // 50 recipients across to, cc, and bcc.
    maxRecipients: 50,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "tsend_...",
      pattern: "^tsend_[A-Za-z0-9_]+$",
      hint: "A sending key from the toSend dashboard. An admin key needs the emails:send scope.",
    },
  ],
  docsUrl: "https://tosend.com/docs/api/send-email/",
  // A 403 means bad credentials or no credits, by the body text. The default (auth) stays.
  statusMap: defineStatusMap({}),
  webhooks: true,
  webhookSecret: {
    label: "Webhook secret",
    source: "provider",
    hint: "The secret that you set on the webhook in toSend. Use a long random value.",
  },
  nativeIdempotency: false,
});
