// `sendBatch`: the send pipeline over many messages. Each message runs the same steps as
// `send`: validation, its own idempotency claim, the chain, and one final record.
// Only the primary attempt changes. When the primary adapter has `sendBatch`, the
// messages that it can send in a batch go out in chunks of `capabilities.batchSize`.
// The other messages go through the single-send chain. After the batch, each `not_sent`
// message goes through the rest of the chain, one send at a time. An `unknown` message
// never goes to a fallback.
//
// The store calls of different messages run at the same time, at most
// `STORE_CONCURRENCY` at once: the claims, the cap reserves, the heartbeats before a
// chunk, the refunds after a chunk, and the final records. The provider calls stay
// sequential: the batch chunks, then the single sends and the fallbacks. Results keep
// the input order.
//
// A key that is used twice in one call waits for the claim of its first message. The
// second message therefore gets `unknown/in_flight`, because the first claim is still
// pending. Each claim gets a heartbeat just before its chunk and before each single send,
// so a long call does not make the later claims stale.
//
// A store failure stops only the message that it belongs to. The other messages go on.

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

/** The most store calls of one `sendBatch` call that run at the same time. */
const STORE_CONCURRENCY = 8;

const ignore = (): void => undefined;

/** Runs `task` for each item, at most `STORE_CONCURRENCY` at once. `task` must not throw. */
async function pool<T>(
  items: readonly T[],
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await task(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(STORE_CONCURRENCY, items.length) }, worker));
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
    // The claim of the last message with each key. A repeated key waits for it.
    const claims = new Map<string, Promise<unknown>>();
    await pool(messages, async (message, i) => {
      const key = (message as OutgoingMessage | null)?.idempotencyKey;
      const before = typeof key === "string" ? claims.get(key) : undefined;
      const claim = (async () => {
        await before;
        return steps.start(message);
      })();
      if (typeof key === "string") {
        // A later copy only waits for this claim. It never sees its error.
        claims.set(key, claim.catch(ignore));
      }
      const started = await claim;
      if ("attempts" in started) runs[i] = started;
      else results[i] = started;
    });
    const batch: Item[] = [];
    const single: MessageRun[] = [];
    for (const run of runs) {
      if (!run) continue;
      if (canBatch && batchable(run, caps)) batch.push({ run });
      else single.push(run);
    }
    if (!steps.hasStore && !warned && batch.some((item) => item.run.message.idempotencyKey)) {
      warned = true;
      steps.warn(UNSAFE_BATCH);
    }
    // One cap unit and one rate limit token per message, as for a single send. A refused
    // message skips the batch.
    const gates: (Item | undefined)[] = new Array(batch.length);
    await pool(batch, async (item, i) => {
      try {
        const gate = await steps.reserve(primary, item.run.message, item.run.encodedBytes);
        if (gate.refusal) await steps.record(item.run, primary, gate.refusal);
        else gates[i] = { run: item.run, bucketStart: gate.bucketStart };
      } catch (error) {
        steps.fail(item.run, error);
      }
    });
    const ready = gates.filter((item) => item !== undefined);
    for (let at = 0; at < ready.length; at += caps.batchSize) {
      // The heartbeat of each claim, just before its chunk. A message that loses its claim,
      // or whose store fails, leaves the chunk and gets its cap unit back.
      const slice = ready.slice(at, at + caps.batchSize);
      const fenced: boolean[] = new Array(slice.length);
      await pool(slice, async (item, i) => {
        fenced[i] = await steps.fence(item.run);
        // `refund` does nothing for a provider with no cap.
        if (!fenced[i]) {
          await steps.refund(primary, item.bucketStart as number, item.run.result as SendResult);
        }
      });
      const chunk = slice.filter((_, i) => fenced[i]);
      if (chunk.length === 0) continue;
      const list = await callBatch(steps, primary, chunk);
      await pool(chunk, async (item, i) => {
        const result = list[i] as SendResult;
        if (item.bucketStart !== undefined && result.status === "not_sent") {
          await steps.refund(primary, item.bucketStart, result);
        }
      });
      for (let i = 0; i < chunk.length; i++) {
        await steps.record((chunk[i] as Item).run, primary, list[i] as SendResult);
      }
    }
    for (const item of batch) await steps.chain(item.run, 1);
    for (const run of single) await steps.chain(run, 0);
    await pool(runs, async (run, i) => {
      if (run) results[i] = await steps.finish(run);
    });
    return results;
  };
}
