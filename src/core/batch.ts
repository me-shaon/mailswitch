// `sendBatch`: the send pipeline over many messages. Each message runs the same steps as
// `send`: validation, its own idempotency claim, the chain, and one final record.
// Only the primary attempt changes. When the primary adapter has `sendBatch`, the
// messages that it can send in a batch go out in chunks of `capabilities.batchSize`.
// The other messages go through the single-send chain. After the batch, each `not_sent`
// message goes through the rest of the chain, one send at a time. An `unknown` message
// never goes to a fallback.
//
// Two paths do the store calls. The bulk path runs when a store has usable bulk methods
// (see `src/internal/bulk-methods.ts`). The per-message path runs for every other store.
// The idempotency store and the daily cap store are detected separately.
//
// The per-message path: the store calls of different messages run at the same time, at
// most `STORE_CONCURRENCY` at once: the claims, the cap reserves, the heartbeats before a
// chunk, the refunds after a chunk, and the final records. A key that is used twice in
// one call waits for the claim of its first message. A store failure stops only the
// message that it belongs to.
//
// The bulk path: each bulk call takes at most 100 inputs (one store chunk), and the store
// chunks of one step run in sequence.
//   1. `claimMany` claims the first valid copy of each key. A later copy of a key claims
//      on the per-message path after the bulk call, in input order.
//   2. `reserveMany` reserves the units of the primary for the batch items. The first
//      items in input order get the units that are left. Each granted item then takes its
//      rate limit token on its own.
//   3. Before each provider chunk, `touchMany` renews the claims of the chunk.
//   4. After each provider chunk, one `releaseMany` refunds the units of each item that
//      stopped before its provider call or got `not_sent`.
//   5. `finishMany` writes the final records of the messages that go to no fallback.
//      The fallbacks and the single sends then run on the per-message path. A second
//      `finishMany` writes their final records.
// A bulk call that throws, or that returns a list of the wrong length, fails every input
// of its store chunk. Before a provider call, each message of the chunk gets
// `not_sent/store_error`. After a provider call, each message keeps its last attempt.
// The other store chunks go on.
//
// The provider calls stay sequential: the batch chunks, then the fallbacks and the
// single sends. Results keep the input order. Each claim gets a heartbeat just before
// its chunk and before each single send, so a long call does not make the later claims
// stale.

import type { BulkIdempotencyStore } from "../internal/bulk-methods";
import { chunks } from "../internal/chunks";
import type { IdempotencyClaimOutcome } from "../stores/types";
import { checkCapabilities } from "./capabilities";
import { capRefusal } from "./daily-cap";
import type { Entry, Gate, MessageRun, PipelineSteps, Prepared } from "./pipeline";
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

/** Returns the result list of a bulk call. A list of the wrong length counts as a throw. */
async function checked<T>(call: Promise<T[]>, length: number): Promise<T[]> {
  const list: unknown = await call;
  if (!Array.isArray(list) || list.length !== length) {
    throw new TypeError("A bulk store call returned a list of the wrong length.");
  }
  return list as T[];
}

type Claim = NonNullable<Prepared["claim"]>;

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

/** Stops each run after a store failure that hit all of them. One warning. */
function failAll(steps: PipelineSteps, runs: readonly MessageRun[], error: unknown): void {
  const result = steps.storeError(error);
  for (const run of runs) {
    run.done = true;
    run.result ??= { ...result };
  }
}

/**
 * Validation and the claims on the bulk path. Sets `runs[i]` for each message that goes
 * on, and `results[i]` for each message that stops.
 */
async function startAll(
  steps: PipelineSteps,
  store: BulkIdempotencyStore,
  messages: readonly OutgoingMessage[],
  runs: (MessageRun | undefined)[],
  results: SendResult[],
): Promise<void> {
  const put = (i: number, out: SendResult | MessageRun): void => {
    if ("attempts" in out) runs[i] = out;
    else results[i] = out;
  };
  const prepared: (Prepared | undefined)[] = new Array(messages.length);
  await pool(messages, async (message, i) => {
    const out = await steps.prepare(message);
    if ("run" in out) prepared[i] = out;
    else results[i] = out;
  });
  // The first valid copy of each key goes in the bulk claim. Later copies wait.
  const keys = new Set<string>();
  const first: number[] = [];
  const later: number[] = [];
  prepared.forEach((item, i) => {
    if (!item) return;
    if (!item.claim) runs[i] = item.run;
    else if (keys.has(item.claim.key)) later.push(i);
    else {
      keys.add(item.claim.key);
      first.push(i);
    }
  });
  for (const part of chunks(first)) {
    const list = part.map((i) => prepared[i] as Prepared);
    const now = steps.now();
    try {
      const inputs = list.map((item) => ({ ...(item.claim as Claim), now }));
      const outcomes = await checked(store.claimMany(inputs), part.length);
      part.forEach((i, at) => {
        put(i, steps.claimed(list[at] as Prepared, outcomes[at] as IdempotencyClaimOutcome));
      });
    } catch (error) {
      const result = steps.storeError(error);
      for (const i of part) results[i] = { ...result };
    }
  }
  // A later copy gets the same outcome as on the per-message path: `in_flight` while the
  // first claim holds the key, the stored result, or a new claim after a failed claim.
  for (const i of later) put(i, await steps.claim(prepared[i] as Prepared));
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
    // Each store is detected on each call, so a store can change its methods between calls.
    const claims = steps.bulkClaims();
    const capStore = primary.cap === undefined ? undefined : steps.bulkCaps();
    const results: SendResult[] = new Array(messages.length);
    const runs: (MessageRun | undefined)[] = new Array(messages.length);
    if (claims) {
      await startAll(steps, claims, messages, runs, results);
    } else {
      // The claim of the last message with each key. A repeated key waits for it.
      const pending = new Map<string, Promise<unknown>>();
      await pool(messages, async (message, i) => {
        const key = (message as OutgoingMessage | null)?.idempotencyKey;
        const before = typeof key === "string" ? pending.get(key) : undefined;
        const claim = (async () => {
          await before;
          return steps.start(message);
        })();
        if (typeof key === "string") {
          // A later copy only waits for this claim. It never sees its error.
          pending.set(key, claim.catch(ignore));
        }
        const started = await claim;
        if ("attempts" in started) runs[i] = started;
        else results[i] = started;
      });
    }
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

    // The cap units to refund on the bulk path, and whether a `quota` answer fills the cap.
    let refunds: number[] = [];
    let fill = false;
    const refund = async (item: Item, result: SendResult): Promise<void> => {
      if (item.bucketStart === undefined) return;
      if (!capStore) return steps.refund(primary, item.bucketStart, result);
      refunds.push(item.bucketStart);
      if (result.status === "not_sent" && result.reason === "quota") fill = true;
    };
    const flush = async (): Promise<void> => {
      if (refunds.length === 0 && !fill) return;
      const list = refunds;
      const quota = fill;
      refunds = [];
      fill = false;
      await steps.releaseAll(primary, list, quota);
    };

    // One cap unit and one rate limit token per message, as for a single send. A refused
    // message skips the batch.
    const gates: (Item | undefined)[] = new Array(batch.length);
    /** Runs the gate of one item. A refusal is its attempt. A store failure stops it. */
    const admit = async (index: number, run: MessageRun, gate: () => Promise<Gate>) => {
      try {
        const out = await gate();
        if (out.refusal) await steps.record(run, primary, out.refusal);
        else gates[index] = { run, bucketStart: out.bucketStart };
      } catch (error) {
        steps.fail(run, error);
      }
    };
    if (capStore) {
      const id = primary.adapter.meta.id;
      let offset = 0;
      for (const part of chunks(batch)) {
        const base = offset;
        offset += part.length;
        let list: Awaited<ReturnType<typeof capStore.reserveMany>>;
        try {
          list = await checked(
            capStore.reserveMany({
              scope: primary.scope,
              cap: primary.cap as number,
              count: part.length,
              now: steps.now(),
            }),
            part.length,
          );
        } catch (error) {
          failAll(
            steps,
            part.map((item) => item.run),
            error,
          );
          continue;
        }
        await pool(part, (item, i) =>
          admit(base + i, item.run, async () => {
            const reservation = list[i] as (typeof list)[number];
            if (!reservation.ok) return { refusal: capRefusal(id, reservation.resetAt) };
            const gated: Item = { run: item.run, bucketStart: reservation.bucketStart };
            const refusal = await steps.limit(primary, (result) => refund(gated, result));
            return refusal ? { refusal } : gated;
          }),
        );
      }
    } else {
      await pool(batch, (item, i) =>
        admit(i, item.run, () => steps.reserve(primary, item.run.message, item.run.encodedBytes)),
      );
    }
    const ready = gates.filter((item) => item !== undefined);
    for (let at = 0; at < ready.length; at += caps.batchSize) {
      // The heartbeat of each claim, just before its chunk. A message that loses its claim,
      // or whose store fails, leaves the chunk and gets its cap unit back.
      const slice = ready.slice(at, at + caps.batchSize);
      const keep: boolean[] = slice.map(() => true);
      /** Takes a message out of the chunk and gives its cap unit back. */
      const drop = async (i: number): Promise<void> => {
        const item = slice[i] as Item;
        keep[i] = false;
        await refund(item, item.run.result as SendResult);
      };
      if (claims) {
        const keyed = slice.flatMap((item, i) => (item.run.claim ? [i] : []));
        for (const part of chunks(keyed)) {
          const now = steps.now();
          const inputs = part.map((i) => {
            const run = (slice[i] as Item).run;
            return {
              ...(run.claim as NonNullable<MessageRun["claim"]>),
              now,
              attempt: run.attempts.at(-1),
            };
          });
          let touched: boolean[];
          try {
            touched = await checked(claims.touchMany(inputs), part.length);
          } catch (error) {
            touched = [];
            failAll(
              steps,
              part.map((i) => (slice[i] as Item).run),
              error,
            );
          }
          for (const [k, i] of part.entries()) {
            if (touched[k]) continue;
            const { run } = slice[i] as Item;
            if (!run.done) steps.lose(run);
            await drop(i);
          }
        }
      } else {
        await pool(slice, async (item, i) => {
          // `refund` does nothing for a provider with no cap.
          if (!(await steps.fence(item.run))) await drop(i);
        });
      }
      const chunk = slice.filter((_, i) => keep[i]);
      if (chunk.length > 0) {
        const list = await callBatch(steps, primary, chunk);
        await pool(chunk, async (item, i) => {
          const result = list[i] as SendResult;
          if (result.status === "not_sent") await refund(item, result);
        });
        for (let i = 0; i < chunk.length; i++) {
          await steps.record((chunk[i] as Item).run, primary, list[i] as SendResult);
        }
      }
      await flush();
    }
    await flush();

    if (!claims) {
      for (const item of batch) {
        if (steps.fallsBack(item.run)) await steps.chain(item.run, 1);
      }
      for (const run of single) await steps.chain(run, 0);
      await pool(runs, async (run, i) => {
        if (run) results[i] = await steps.finish(run);
      });
      return results;
    }

    // Final records first for the messages that go to no fallback, so a fallback loop
    // that uses up the store budget cannot leave them pending.
    const later = new Set<MessageRun>(single);
    for (const item of batch) if (steps.fallsBack(item.run)) later.add(item.run);
    await finishAll(
      steps,
      claims,
      runs.filter((run): run is MessageRun => run !== undefined && !later.has(run)),
    );
    for (const item of batch) if (later.has(item.run)) await steps.chain(item.run, 1);
    for (const run of single) await steps.chain(run, 0);
    await finishAll(steps, claims, [...later]);
    runs.forEach((run, i) => {
      if (run) results[i] = run.result as SendResult;
    });
    return results;
  };
}

/** Writes the final records of `runs` with `finishMany`. It never throws. */
async function finishAll(
  steps: PipelineSteps,
  store: BulkIdempotencyStore,
  runs: readonly MessageRun[],
): Promise<void> {
  for (const part of chunks(runs.filter((run) => run.claim))) {
    try {
      const applied = await checked(
        store.finishMany(part.map((run) => steps.finishInput(run))),
        part.length,
      );
      part.forEach((run, k) => {
        if (!applied[k]) steps.unfinished(run, false);
      });
    } catch (error) {
      for (const run of part) steps.unfinished(run, true, error);
    }
  }
}
