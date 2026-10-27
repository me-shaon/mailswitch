// Generic HTTP provider data. Pure data: the catalog imports this file without the
// adapter. This entry describes only the credential form of the JSON config API: one
// secret `token`. Each adapter that `httpProvider` or `httpProviderFromConfig` builds has
// its own meta, with the id and the capabilities of its config. `getProviderMeta` finds
// the catalog entry `http`, never the id of a built adapter.

import { defineStatusMap } from "../../core/classify";
import { type CredentialField, defineProviderMeta, type ProviderMeta } from "../../core/meta";
import type { Capabilities } from "../../core/types";

/** The docs URL of the generic provider. */
export const HTTP_DOCS_URL =
  "https://github.com/me-shaon/mailswitch/blob/main/docs/providers/http.md";

export const httpMeta: ProviderMeta = defineProviderMeta({
  id: "http",
  name: "Generic HTTP",
  // Tier 2: send, attachments, and verify. The endpoint has no researched docs, so every
  // 5xx, every 3xx, 408, and 409 stay unknown.
  tier: 2,
  // The least that every JSON config adapter can send. A built adapter sets cc, bcc,
  // replyTo, and customHeaders to true when its field map names them.
  capabilities: {
    attachments: true,
    maxMessageBytes: null,
    cc: false,
    bcc: false,
    replyTo: false,
    customHeaders: false,
    idempotency: false,
    batchSize: 1,
  },
  credentialFields: [
    {
      name: "token",
      label: "API token",
      secret: true,
      required: true,
      // Printable ASCII with no space, so the token is safe in a header.
      pattern: "^[\\x21-\\x7e]{1,4096}$",
      hint: "The token of the API. The config names the header or the auth type that carries it.",
    },
  ],
  docsUrl: HTTP_DOCS_URL,
  // The generic provider has its own base table in its adapter. See classify.ts.
  statusMap: defineStatusMap({}),
  webhooks: false,
  nativeIdempotency: false,
});

/**
 * The meta of one built generic adapter, at tier 2. The base table of the generic
 * provider is in classify.ts, and a tier 2 status map keeps every 5xx unknown.
 */
export function genericMeta(
  id: string,
  name: string,
  capabilities: Capabilities,
  credentialFields: readonly CredentialField[],
  docsUrl: string,
): ProviderMeta {
  return defineProviderMeta({
    id,
    name,
    tier: 2,
    capabilities,
    credentialFields,
    docsUrl,
    statusMap: defineStatusMap({}),
    webhooks: false,
    nativeIdempotency: false,
  });
}
