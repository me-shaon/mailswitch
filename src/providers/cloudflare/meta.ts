// Cloudflare Email Sending provider data. Pure data: the catalog imports this file without
// the adapter. There are two entries, one per transport, because their credential fields
// differ. The REST transport needs an account ID and an API token. The binding transport
// needs only the name of the `send_email` binding.
//
// https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
// https://developers.cloudflare.com/email-service/platform/limits/

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";
import type { Capabilities } from "../../core/types";

const DOCS = "https://developers.cloudflare.com/email-service/";

// 5 MiB per message, attachments included. 50 addresses across to, cc, and bcc.
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 50;

const shared: Omit<Capabilities, "batchSize"> = {
  attachments: true,
  maxMessageBytes: MAX_MESSAGE_BYTES,
  cc: true,
  bcc: true,
  replyTo: true,
  customHeaders: true,
  idempotency: false,
  maxRecipients: MAX_RECIPIENTS,
};

/**
 * The REST transport. The default status table is correct for every documented error, so
 * the status map is empty. Every 5xx stays `unknown`, including 503 code 10100, because
 * the map is keyed by HTTP status and another 503 can come after acceptance.
 */
export const cloudflareRestMeta: ProviderMeta = defineProviderMeta({
  id: "cloudflare-rest",
  name: "Cloudflare Email (REST API)",
  tier: 1,
  // The REST API has no batch endpoint. `sendBatch` sends up to 25 messages, 5 at a time.
  capabilities: { ...shared, batchSize: 25 },
  credentialFields: [
    {
      name: "accountId",
      label: "Account ID",
      secret: false,
      required: true,
      pattern: "^[A-Za-z0-9]{32}$",
      hint: "On the Overview page of your Cloudflare dashboard.",
    },
    {
      name: "apiToken",
      label: "API token",
      secret: true,
      required: true,
      hint: "A token with the Email Sending permission for the account.",
    },
  ],
  docsUrl: DOCS,
  statusMap: defineStatusMap({}),
  webhooks: false,
  nativeIdempotency: false,
});

/**
 * The Workers binding transport. It makes no HTTP call, so it has no status map. A thrown
 * error is `unknown` unless its documented code proves that Cloudflare did not accept the
 * message.
 */
export const cloudflareBindingMeta: ProviderMeta = defineProviderMeta({
  id: "cloudflare-binding",
  name: "Cloudflare Email (Workers binding)",
  tier: 1,
  capabilities: { ...shared, batchSize: 1 },
  credentialFields: [
    {
      name: "bindingName",
      label: "Binding name",
      secret: false,
      required: true,
      defaultValue: "EMAIL",
      pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
      hint: "The name of the send_email binding in your Wrangler configuration.",
    },
  ],
  docsUrl: DOCS,
  statusMap: defineStatusMap({}),
  webhooks: false,
  nativeIdempotency: false,
});
