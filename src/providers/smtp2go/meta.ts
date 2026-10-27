// SMTP2GO provider data. Pure data: the catalog imports this file without the adapter.
// Checked 2026-10-27.
// https://developers.smtp2go.com/reference/send-standard-email.md
// https://developers.smtp2go.com/docs/getting-started.md
// https://developers.smtp2go.com/docs/response-codes
// https://developers.smtp2go.com/docs/rate-limiting.md
// https://developers.smtp2go.com/docs/webhooks-overview.md

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

const RESPONSE_CODES = "https://developers.smtp2go.com/docs/response-codes";

export const smtp2goMeta: ProviderMeta = defineProviderMeta({
  id: "smtp2go",
  name: "SMTP2GO",
  tier: 1,
  capabilities: {
    attachments: true,
    // "The maximum email size when sending via the API is 50 MB (this includes content,
    // attachments and headers)." (getting-started)
    maxMessageBytes: 50_000_000,
    cc: true,
    bcc: true,
    // The API has no reply-to field. The adapter sends a Reply-To custom header.
    replyTo: true,
    customHeaders: true,
    // SMTP2GO accepts no idempotency key.
    idempotency: false,
    // The batch endpoint does not document how it reports a failed item.
    batchSize: 1,
    // To, Cc, and Bcc each take "up to 100" addresses. The adapter checks each field.
    maxRecipients: 300,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      // The API error text names the format 'api-[A-Za-z0-9]{32}' (observed 2026-10-27).
      pattern: "^api-[A-Za-z0-9]{32}$",
      hint: "The API key from Sending, API Keys in the SMTP2GO app. It starts with api-.",
    },
  ],
  docsUrl: "https://developers.smtp2go.com/reference/send-standard-email.md",
  // 401 and 403 are auth in the default table. A 429 is rate_limited, and the adapter adds
  // a 60 s wait. Every 5xx stays unknown: no SMTP2GO document says that a 5xx sent nothing.
  statusMap: defineStatusMap({
    // "402 - Request Failed: The parameters were valid but the request failed." It is not
    // a credit error, so the default `credits` reason does not fit.
    402: { status: "not_sent", reason: "rejected", source: RESPONSE_CODES },
  }),
  webhooks: true,
  nativeIdempotency: false,
});
