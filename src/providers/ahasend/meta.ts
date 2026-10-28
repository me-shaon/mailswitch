// AhaSend provider data. Pure data: the catalog imports this file without the adapter.
// Checked 2026-10-27.
// https://ahasend.com/docs/api-reference/messages/create-conversation.md
// https://ahasend.com/docs/api-reference/authentication.md
// https://ahasend.com/docs/api-reference/errors.md
// https://ahasend.com/docs/api-reference/idempotency.md
// https://ahasend.com/docs/api-reference/webhooks/security.md

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

const ERRORS_DOCS = "https://ahasend.com/docs/api-reference/errors.md";
const IDEMPOTENCY_DOCS = "https://ahasend.com/docs/api-reference/idempotency.md";

export const ahasendMeta: ProviderMeta = defineProviderMeta({
  id: "ahasend",
  name: "AhaSend",
  tier: 1,
  capabilities: {
    attachments: true,
    // The send endpoint states no size limit. mailswitch uses 10 MB until a live test or
    // the limits page confirms the real value.
    maxMessageBytes: 10_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    idempotency: true,
    // AhaSend has no batch endpoint for distinct messages.
    batchSize: 1,
    // At most 50 each in to, cc, and bcc. The adapter checks each list before the request.
    maxRecipients: 150,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "aha-sk-...",
      pattern: "^aha-sk-\\S{20,}$",
      hint: "An API key from the AhaSend dashboard with permission to send. A key with an IP allowlist fails from Cloudflare Workers.",
    },
    {
      name: "accountId",
      label: "Account ID",
      secret: false,
      required: true,
      placeholder: "00000000-0000-0000-0000-000000000000",
      // A UUID in practice. The pattern accepts any id that is safe in a URL path.
      pattern: "^[A-Za-z0-9-]{8,64}$",
      hint: "The account ID (a UUID) from the AhaSend dashboard.",
    },
  ],
  docsUrl: "https://ahasend.com/docs/api-reference/messages/create-conversation.md",
  // 400 is invalid_message, 401 and 403 are auth, and 429 reads Retry-After: the default
  // table matches the documented answers. Every 5xx stays unknown.
  statusMap: defineStatusMap({
    // A request with the same Idempotency-Key is still in progress. It may send.
    409: { status: "unknown", reason: "idempotency_conflict", source: IDEMPOTENCY_DOCS },
    // The key was used before with a different method, path, or body. The earlier
    // request may have sent, so the result is unknown.
    422: { status: "unknown", reason: "idempotency_conflict", source: ERRORS_DOCS },
  }),
  webhooks: true,
  webhookSecret: {
    label: "Webhook secret",
    source: "provider",
    hint: "The secret of the webhook in AhaSend. Store the whole value, with the aha-whsec- prefix.",
    placeholder: "aha-whsec-...",
    pattern: "^aha-whsec-\\S+$",
  },
  nativeIdempotency: true,
  // AhaSend keeps a key for 24 hours.
  nativeIdempotencyWindowMs: 86_400_000,
});
