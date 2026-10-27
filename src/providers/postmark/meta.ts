// Postmark provider data. Pure data: the catalog imports this file without the adapter.
// https://postmarkapp.com/developer/api/email-api
// https://postmarkapp.com/developer/api/overview

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const postmarkMeta: ProviderMeta = defineProviderMeta({
  id: "postmark",
  name: "Postmark",
  tier: 1,
  capabilities: {
    attachments: true,
    // A 413 means a request larger than 10 MB on POST /email. mailswitch checks the size
    // after encoding, which is the safe side.
    maxMessageBytes: 10_000_000,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    // Postmark accepts no idempotency key. The mailer store gives the only protection.
    idempotency: false,
    // POST /email/batch takes up to 500 messages.
    batchSize: 500,
    // 50 recipients across To, Cc, and Bcc.
    maxRecipients: 50,
  },
  credentialFields: [
    {
      name: "serverToken",
      label: "Server API token",
      secret: true,
      required: true,
      placeholder: "00000000-0000-0000-0000-000000000000",
      pattern: "^(?:POSTMARK_API_TEST|[A-Za-z0-9-]{16,64})$",
      hint: "On the API Tokens tab of your Postmark server. It is not the account token.",
    },
    {
      name: "messageStream",
      label: "Message stream ID",
      secret: false,
      required: false,
      placeholder: "outbound",
      pattern: "^[a-z0-9-]{1,30}$",
      hint: "Leave it empty to use the default transactional stream, outbound.",
    },
  ],
  docsUrl: "https://postmarkapp.com/developer/api/email-api",
  // Postmark documents every 5xx as a server fault or an outage, with no statement that
  // the message did not go out. So the default table stays: every 5xx is unknown. The
  // adapter refines the reason of a 422 with the Postmark ErrorCode.
  statusMap: defineStatusMap({}),
  webhooks: true,
  webhookSecret: {
    label: "Webhook secret",
    source: "generated",
    hint: "Make it with generatePostmarkWebhookSecret(). Enter it as the Basic auth password of the Postmark webhook.",
  },
  nativeIdempotency: false,
});
