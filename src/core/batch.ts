// `sendBatch`: the send pipeline over many messages. Each message runs the same steps as
// `send`: validation, its own idempotency claim, the chain, and one final record.
// Only the primary attempt changes. When the primary adapter has `sendBatch`, the
// messages that it can send in a batch go out in chunks of `capabilities.batchSize`.
// The other messages go through the single-send chain. After the batch, each `not_sent`
// message goes through the rest of the chain, one send at a time. An `unknown` message
// never goes to a fallback.
//
// The work is sequential: claims in input order, then the batch chunks, then the single
// sends and the fallbacks. A key that is used twice in one call therefore gets
// `unknown/in_flight` for the second message, because the first claim is still pending.

import { checkCapabilities } from "./capabilities";
import type { Entry, MessageRun, PipelineSteps } from "./pipeline";
import type { Capabilities, OutgoingMessage, SendResult } from "./types";

const UNSAFE_BATCH =
  "mailswitch: a keyed batch went out with no idempotency store. A batch request carries no idempotency key, so a retry can send a second copy.";

/** Whether a message can go in a batch request of a provider with these capabilities. */
function batchable(run: MessageRun, caps: Capabilities): boolean {
  if (checkCapabilities(run.message, caps, run.encodedBytes)) return false;
  return !(caps.batchAttachments === false && (run.message.attachments?.length ?? 0) > 0);
}

interface Item {
  run: MessageRun;
  bucketStart?: number;
}

/** One batch request. Every result is checked. A throw or a bad list is `unknown` for all. */
async function callBatch(
  steps: PipelineSteps,
  entry: Entry,
  items: readonly Item[],
): Promise<SendResult[]> {
  const { adapter } = entry;
  const id = adapter.meta.id;
  let out: unknown;
  try {
    out = await adapter.sendBatch?.(
      items.map((item) => item.run.message),
      steps.context(entry),
    );
  } catch {
    out = undefined;
  }
  const list = Array.isArray(out) && out.length === items.length ? out : [];
  return items.map((_, index) => steps.check(list[index], id));
}

/** Builds the `sendBatch` method over the shared pipeline steps. Internal. */
export function createBatchSender(
  steps: PipelineSteps,
): (messages: readonly OutgoingMessage[]) => Promise<SendResult[]> {
  const primary = steps.entries[0] as Entry;
  const caps = primary.adapter.meta.capabilities;
  const canBatch = typeof primary.adapter.sendBatch === "function" && caps.batchSize > 1;
  let warned = false;

  return async function sendBatch(messages) {
    if (!Array.isArray(messages)) {
      throw new TypeError("sendBatch expects an array of messages.");
    }
    const results: SendResult[] = new Array(messages.length);
    const runs: (MessageRun | undefined)[] = new Array(messages.length);
    const open = new Set<MessageRun>();
    try {
      const batch: Item[] = [];
      const single: MessageRun[] = [];
      for (let i = 0; i < messages.length; i++) {
        const started = await steps.start(messages[i] as OutgoingMessage);
        if (!("attempts" in started)) {
          results[i] = started;
          continue;
        }
        runs[i] = started;
        open.add(started);
        if (canBatch && batchable(started, caps)) batch.push({ run: started });
        else single.push(started);
      }
      if (!steps.hasStore && !warned && batch.some((item) => item.run.message.idempotencyKey)) {
        warned = true;
        steps.warn(UNSAFE_BATCH);
      }
      // One cap unit per message, as for a single send. A refused message skips the batch.
      const ready: Item[] = [];
      for (const item of batch) {
        const gate = await steps.reserve(primary, item.run.message, item.run.encodedBytes);
        if (gate.refusal) await steps.record(item.run, primary, gate.refusal);
        else ready.push({ run: item.run, bucketStart: gate.bucketStart });
      }
      for (let at = 0; at < ready.length; at += caps.batchSize) {
        const chunk = ready.slice(at, at + caps.batchSize);
        const list = await callBatch(steps, primary, chunk);
        for (let i = 0; i < chunk.length; i++) {
          const item = chunk[i] as Item;
          const result = list[i] as SendResult;
          if (item.bucketStart !== undefined && result.status === "not_sent") {
            await steps.refund(primary, item.bucketStart, result);
          }
          await steps.record(item.run, primary, result);
        }
      }
      for (const item of batch) await steps.chain(item.run, 1);
      for (const run of single) await steps.chain(run, 0);
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (!run) continue;
        open.delete(run);
        results[i] = await steps.finish(run);
      }
    } catch (error) {
      // A cap store failed. Every open claim gets a final state, then the error leaves.
      for (const run of open) await steps.abort(run);
      throw error;
    }
    return results;
  };
}
