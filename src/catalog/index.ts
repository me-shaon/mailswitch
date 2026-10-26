// mailswitch/catalog: the data of every built-in provider, for a settings form or docs.
// It imports only meta files, so no adapter code is in this bundle.

import type { ProviderMeta } from "../core/meta";
import { resendMeta } from "../providers/resend/meta";
import { toSendMeta } from "../providers/tosend/meta";

export type { CredentialField, ProviderMeta, ProviderPreset, ProviderTier } from "../core/meta";

/** Every built-in provider, in a stable order. */
export const catalog: readonly ProviderMeta[] = Object.freeze([resendMeta, toSendMeta]);

/** Returns the meta of a built-in provider, or undefined for an unknown id. */
export function getProviderMeta(id: string): ProviderMeta | undefined {
  return catalog.find((meta) => meta.id === id);
}
