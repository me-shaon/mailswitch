// Scaleway Transactional Email provider data. Pure data: the catalog imports this file
// without the adapter. The API is v1alpha1. Checked 2026-10-27.
// https://www.scaleway.com/en/developers/api/transactional-email/v1alpha1/schema.yml
// https://www.scaleway.com/en/docs/transactional-email/reference-content/tem-capabilities-and-limits/
// https://www.scaleway.com/en/developers/api/

import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../core/meta";

export const scalewayMeta: ProviderMeta = defineProviderMeta({
  id: "scaleway",
  name: "Scaleway Transactional Email",
  // Tier 2: send, attachments, and verify. Scaleway webhooks are deferred.
  tier: 2,
  capabilities: {
    attachments: true,
    // "2 MB" for one email, attachments included. The limit cannot be raised.
    // mailswitch uses 2,000,000 bytes, which is the safe side.
    maxMessageBytes: 2_000_000,
    cc: true,
    bcc: true,
    // Reply-To goes in `additional_headers`.
    replyTo: true,
    customHeaders: true,
    // Scaleway accepts no idempotency key.
    idempotency: false,
    // Scaleway has no batch endpoint.
    batchSize: 1,
    // At most 10 recipients per email, across to, cc, and bcc.
    maxRecipients: 10,
  },
  credentialFields: [
    {
      name: "secretKey",
      label: "Secret key",
      secret: true,
      required: true,
      placeholder: "00000000-0000-0000-0000-000000000000",
      // A UUID in practice. The pattern accepts any id that is safe in a header.
      pattern: "^[A-Za-z0-9-]{8,64}$",
      hint: "The secret key of an IAM API key with Transactional Email access.",
    },
    {
      name: "projectId",
      label: "Project ID",
      secret: false,
      required: true,
      placeholder: "00000000-0000-0000-0000-000000000000",
      // A UUID in practice. The pattern accepts any id that is safe in a query.
      pattern: "^[A-Za-z0-9-]{8,64}$",
      hint: "The ID of the Project that holds the verified domain.",
    },
  ],
  docsUrl: "https://www.scaleway.com/en/developers/api/transactional-email/",
  // Tier 2 keeps the default table. Every 5xx stays unknown. The adapter refines a 4xx
  // reason from the error `type` in the body.
  statusMap: defineStatusMap({}),
  webhooks: false,
  nativeIdempotency: false,
});
