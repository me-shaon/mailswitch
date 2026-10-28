// A fake provider with a batch endpoint, for the `sendBatch` tests in Node and in workerd.

import { defineProvider, type ProviderAdapter } from "../../src/core/adapter";
import { defineProviderMeta } from "../../src/core/meta";
import type { OutgoingMessage, SendResult } from "../../src/core/types";
import { fakeMeta, fakeProvider } from "../../src/testing/fake-provider";

/** Options of `batchProvider`. */
export interface BatchProviderOptions {
  /** The provider id. Defaults to `batcher`. */
  id?: string;
  /** The most messages in one batch request. Defaults to 10. */
  batchSize?: number;
  /** Maps a recipient to its result. `undefined` means `sent`. */
  outcome?: (to: string) => SendResult | undefined;
}

/** A batch provider. It records each batch request and each single send. */
export function batchProvider(options: BatchProviderOptions = {}): {
  adapter: ProviderAdapter;
  batches: OutgoingMessage[][];
  singles: OutgoingMessage[];
} {
  const id = options.id ?? "batcher";
  const base = fakeMeta(id);
  const meta = defineProviderMeta({
    ...base,
    capabilities: { ...base.capabilities, batchSize: options.batchSize ?? 10 },
  });
  const batches: OutgoingMessage[][] = [];
  const singles: OutgoingMessage[] = [];
  const result = (m: OutgoingMessage): SendResult => {
    const to = m.to[0] as string;
    return options.outcome?.(to) ?? { status: "sent", providerMessageId: `${id}-${to}` };
  };
  const adapter: ProviderAdapter = defineProvider({
    meta,
    async send(m) {
      singles.push(m);
      return result(m);
    },
    async sendBatch(list) {
      batches.push([...list]);
      return list.map(result);
    },
    async verify() {
      return { ok: true };
    },
    webhooks: fakeProvider().webhooks,
  });
  return { adapter, batches, singles };
}
