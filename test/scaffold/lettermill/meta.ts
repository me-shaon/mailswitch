// Lettermill provider data. Lettermill is a fictional provider: it is the worked example of
// docs/guides/add-a-provider.md. This file started as the scaffold output of
// `mailswitch-scaffold lettermill --out <dir>`. A custom provider imports the same names
// from "mailswitch/provider-kit".

import { defineStatusMap } from "../../../src/core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../../src/core/meta";

export const lettermillMeta: ProviderMeta = defineProviderMeta({
  id: "lettermill",
  name: "Lettermill",
  // Tier 2: send, attachments, and verify. Every 5xx stays unknown.
  tier: 2,
  capabilities: {
    attachments: true,
    // 20 MB per message after base64 encoding.
    maxMessageBytes: 20_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    idempotency: false,
    // Lettermill has no batch endpoint.
    batchSize: 1,
    // 50 recipients across to, cc, and bcc.
    maxRecipients: 50,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "lm_live_...",
      pattern: "^lm_live_[A-Za-z0-9]+$",
    },
  ],
  docsUrl: "https://lettermill.example/docs/api",
  // The default table already maps 401 to auth, 402 to credits, and 422 to invalid_message.
  // A 409 means "a message with this content is in progress". The first request may send.
  statusMap: defineStatusMap({
    409: {
      status: "unknown",
      reason: "provider_error",
      source: "https://lettermill.example/docs/api/errors",
    },
  }),
  webhooks: true,
  nativeIdempotency: false,
});
