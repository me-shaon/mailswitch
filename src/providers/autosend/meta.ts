// AutoSend provider data. Pure data: the catalog imports this file without the adapter.
// Checked 2026-10-27.
// https://docs.autosend.com/api-reference/mails/send.md
// https://docs.autosend.com/api-keys.md
// https://docs.autosend.com/api-reference/errors.md
// https://docs.autosend.com/api-reference/rate-limit.md
// https://docs.autosend.com/others/webhooks/event-type.md

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const autosendMeta: ProviderMeta = defineProviderMeta({
  id: "autosend",
  name: "AutoSend",
  tier: 1,
  capabilities: {
    attachments: true,
    // "The total size of the email should be max 40MB after Base64 encoding of the
    // attachments." mailswitch uses 40,000,000 bytes, which is the safe side.
    maxMessageBytes: 40_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // AutoSend accepts no idempotency key. The mailer store gives the only protection.
    idempotency: false,
    // The bulk endpoint shares one content for all recipients and takes no attachments,
    // so the core sends one message at a time.
    batchSize: 1,
    // "The total combined recipients across to, cc, and bcc cannot exceed 50 per email."
    maxRecipients: 50,
  },
  credentialFields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "AS_...",
      // A project key starts with AS_ and an account key with ASA_.
      pattern: "^[Aa][Ss][Aa]?_\\S{1,512}$",
      hint: "A project API key (AS_). An account API key (ASA_) also needs the project ID.",
    },
    {
      name: "projectId",
      label: "Project ID",
      secret: false,
      required: false,
      // AutoSend documents no project id format. The pattern checks only printable ASCII
      // with no space, and the length.
      pattern: "^[\\x21-\\x7e]{1,128}$",
      hint: "Only for an account API key (ASA_). mailswitch sends it in the x-project-id header.",
    },
  ],
  docsUrl: "https://docs.autosend.com/api-reference/mails/send.md",
  // The documented 400, 401, 402, 403, 404, and 429 answers match the default table. The
  // adapter refines the reason from the body code. Every 5xx stays unknown, because no
  // doc states that the message did not go out.
  statusMap: defineStatusMap({}),
  webhooks: true,
  nativeIdempotency: false,
});
