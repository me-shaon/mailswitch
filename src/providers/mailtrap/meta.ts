// Mailtrap provider data. Pure data: the catalog imports this file without the adapter.
// Checked 2026-10-27.
// https://docs.mailtrap.io/developers/email-sending/transactional/send-transactional-email.md
// https://docs.mailtrap.io/developers/authentication.md
// https://docs.mailtrap.io/email-api-smtp/setup/sending-limits.md
// https://docs.mailtrap.io/email-api-smtp/advanced/webhooks.md

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const mailtrapMeta: ProviderMeta = defineProviderMeta({
  id: "mailtrap",
  name: "Mailtrap",
  tier: 1,
  capabilities: {
    attachments: true,
    // "10 MB per message", attachments included.
    maxMessageBytes: 10_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // Mailtrap accepts no idempotency key. The mailer store gives the only protection.
    idempotency: false,
    // A batch entry mainly sets recipients. The docs do not say that each entry can carry
    // its own content, so the core sends one message at a time.
    batchSize: 1,
    // At most 1000 each in to, cc, and bcc. mailswitch caps the sum, which is the safe side.
    maxRecipients: 1000,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API token",
      secret: true,
      required: true,
      placeholder: "Your Mailtrap API token",
      // Mailtrap documents no token format, so the pattern checks only the character set
      // and the length.
      pattern: "^[A-Za-z0-9._-]{16,512}$",
      hint: "An API token with access to the sending domain. Verify also needs read access to the account.",
    },
  ],
  docsUrl:
    "https://docs.mailtrap.io/developers/email-sending/transactional/send-transactional-email.md",
  // The documented 400, 401, 403, and 429 answers match the default table. Every 5xx
  // stays unknown, because no doc states that the message did not go out.
  statusMap: defineStatusMap({}),
  webhooks: true,
  nativeIdempotency: false,
});
