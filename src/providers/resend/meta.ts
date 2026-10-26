// Resend provider data. Pure data: the catalog imports this file without the adapter.

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

const IDEMPOTENCY_DOCS = "https://resend.com/docs/dashboard/emails/idempotency-keys";

export const resendMeta: ProviderMeta = defineProviderMeta({
  id: "resend",
  name: "Resend",
  tier: 1,
  capabilities: {
    attachments: true,
    // 40 MB per email, including attachments, after base64 encoding.
    maxMessageBytes: 40_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    idempotency: true,
    batchSize: 50,
    // POST /emails/batch refuses attachments.
    batchAttachments: false,
    maxRecipients: 50,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "re_...",
      pattern: "^re_[A-Za-z0-9_]+$",
    },
  ],
  docsUrl: "https://resend.com/docs",
  statusMap: defineStatusMap({
    // 409 means the key is in use: another request with it is running, or it was used with
    // a different payload. The earlier request may have sent, so the result is unknown.
    409: { status: "unknown", reason: "idempotency_conflict", source: IDEMPOTENCY_DOCS },
  }),
  webhooks: true,
  nativeIdempotency: true,
});
