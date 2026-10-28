// The send pipeline. The order is fixed:
//   1. Validation.
//   2. One idempotency claim, when a store is set and the message has a key.
//   3. For each provider: the claim heartbeat (`touch`), capability check, daily cap
//      reserve, rate limit, send, observe hook. A rate limit refusal refunds the cap unit
//      of the attempt. Stop on `sent` or `unknown`. Go on after `not_sent` only when
//      fallback allows it. A lost claim stops the chain with `unknown/stale_pending`.
//   4. One final record, when there is a claim.
// `sendBatch` (batch.ts) runs the same steps. Only the primary attempt changes.
//
// A store failure never throws out of `send` or `sendBatch`. It stops the message. The
// message keeps the result of its last attempt, or gets `not_sent/store_error` when it had
// none. On the bulk path of `sendBatch`, a failed bulk call stops every message of its
// store chunk. A final record that fails to write leaves the claim `pending`. It goes
// stale later, which is the safe direction.

import {
  type BulkDailyCapStore,
  type BulkIdempotencyStore,
  hasBulkDailyCap,
  hasBulkIdempotency,
} from "../internal/bulk-methods";
import { chunks } from "../internal/chunks";
import { DEFAULT_TIMEOUT_MS, type FetchLike } from "../internal/http";
import type {
  DailyCapStore,
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinishInput,
  IdempotencyStore,
  RateLimitStore,
} from "../stores/types";
import type { ProviderAdapter, ProviderCredentials, SendContext } from "./adapter";
import { createBatchSender } from "./batch";
import { checkCapabilities } from "./capabilities";
import { checkCredentials } from "./credentials";
import { capRefusal, checkDailyCap } from "./daily-cap";
import { allowFallback, type ShouldFallback } from "./fallback";
import { type AttemptView, errorName, type MailerLogger, safeWarn } from "./hooks";
import {
  claimInput,
  claimResult,
  DEFAULT_PENDING_TIMEOUT_MS,
  finishInput,
  minPendingTimeout,
  namespacedKey,
  SENT_RETENTION_MS,
} from "./idempotency";
import { validateMessage } from "./message";
import { checkRate, type RateRule } from "./rate-limit";
import type { SocketConnect } from "./socket";
import type { NotSentResult, OutgoingMessage, SendResult, UnknownResult } from "./types";

/** One provider in the chain. The first entry is the primary. */
export interface MailerProvider {
  adapter: ProviderAdapter;
  /** The raw credentials. `createMailer` checks them with `parseCredentials`. */
  credentials: Readonly<Record<string, unknown>>;
  /** A preset id of the adapter meta. Its fixed values and `defaultDailyCap` apply. */
  preset?: string;
  /**
   * The most sends in a rolling 24 hours. It needs the `dailyCaps` store. It defaults to
   * the `defaultDailyCap` of the preset, then of the meta, when a `dailyCaps` store is set.
   */
  dailyCap?: number;
  /**
   * The cap counter and rate limit bucket name. Defaults to the provider id. Give one
   * per provider account.
   */
  scope?: string;
  /**
   * The most send attempts per second, as a token bucket. It needs the `rateLimits`
   * store. `burst` is the most tokens the bucket holds. It defaults to `perSecond`, and
   * is at least 1. A batch request takes one token per message.
   */
  rate?: { perSecond: number; burst?: number };
}

/** Options of `createMailer`. */
export interface MailerOptions {
  /** The provider chain: the primary first, then the fallbacks in order. */
  providers: readonly MailerProvider[];
  /**
   * A stable name for the idempotency keys of this app. It is required with an
   * `idempotency` store. Changing it frees every key.
   */
  namespace?: string;
  /** Claims each keyed message once across the whole chain. */
  idempotency?: IdempotencyStore;
  /** Counts the daily cap of each provider with a `dailyCap`. */
  dailyCaps?: DailyCapStore;
  /** Keeps the token bucket of each provider with a `rate`. */
  rateLimits?: RateLimitStore;
  /**
   * The time after which a `pending` claim is stale. Defaults to 10 minutes. It must be
   * at least `timeoutMs` multiplied by the chain length.
   */
  pendingTimeoutMs?: number;
  /** The timeout of one provider request. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Outbound HTTP. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Outbound TCP for socket adapters (SMTP). */
  connect?: SocketConnect;
  /** Narrows the fallback rule. See `ShouldFallback`. */
  shouldFallback?: ShouldFallback;
  /** Gets a redacted view after each attempt. Its errors are caught and logged. */
  onAttempt?: (view: AttemptView) => void | Promise<void>;
  /** Gets warnings. The data holds ids and reasons only. */
  logger?: MailerLogger;
  /** The clock, in Unix milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/** A mailer. */
export interface Mailer {
  /** Sends one message through the chain. A provider failure is a result. */
  send(message: OutgoingMessage): Promise<SendResult>;
  /**
   * Sends fully built messages. It returns one result per message, in input order. Each
   * message runs its own claim. With bulk-capable stores, the claims, the first cap
   * reserves, the heartbeats, the refunds, and the final records use bulk store calls.
   * Otherwise each message uses the per-message path. See `createMailer` for the batch
   * rules.
   */
  sendBatch(messages: readonly OutgoingMessage[]): Promise<SendResult[]>;
}

/** One prepared provider of the chain. Internal. */
export interface Entry {
  adapter: ProviderAdapter;
  credentials: ProviderCredentials;
  /** The credential fields that got the field default. */
  defaulted: ReadonlySet<string>;
  cap?: number;
  rate?: RateRule;
  scope: string;
}

/** The state of one message in the pipeline, from the claim to the final record. Internal. */
export interface MessageRun {
  message: OutgoingMessage;
  encodedBytes: number;
  claim?: { key: string; claimId: string };
  attempts: IdempotencyAttempt[];
  /** The result of the last attempt. */
  result?: SendResult;
  /** True when a store failure or a lost claim stopped the run. No further provider call. */
  done?: boolean;
  /**
   * True when the claim was just written. The first `fence` runs right after the claim,
   * so `fence` skips that heartbeat. Only `send` sets it.
   */
  freshClaim?: boolean;
}

/** A validated message and its claim input, before any store call. Internal. */
export interface Prepared {
  run: MessageRun;
  /** The claim input without the time. Only for a keyed message with a store. */
  claim?: Omit<IdempotencyClaimInput, "now">;
}

/** The outcome of the capability check and the cap reserve. Internal. */
export interface Gate {
  refusal?: SendResult;
  /** The cap bucket of the reserved unit. Undefined when the provider has no cap. */
  bucketStart?: number;
}

/** The pipeline steps that `send` and `sendBatch` share. Internal. */
export interface PipelineSteps {
  entries: readonly Entry[];
  hasStore: boolean;
  start(message: OutgoingMessage): Promise<SendResult | MessageRun>;
  /** Validation and the claim input, with no store call. */
  prepare(message: OutgoingMessage): Promise<SendResult | Prepared>;
  /** The claim of one prepared message on the per-message path. It never throws. */
  claim(prepared: Prepared): Promise<SendResult | MessageRun>;
  /** Applies a claim outcome to a prepared message. A malformed outcome gives `store_error`. */
  claimed(prepared: Prepared, outcome: IdempotencyClaimOutcome): SendResult | MessageRun;
  /** The idempotency store when `sendBatch` can use its bulk methods. */
  bulkClaims(): BulkIdempotencyStore | undefined;
  /** The daily cap store when `sendBatch` can use its bulk methods. */
  bulkCaps(): BulkDailyCapStore | undefined;
  /**
   * The rate limit only. On a refusal or a store failure, `release` runs first. Only the
   * store can throw.
   */
  limit(
    entry: Entry,
    release?: (result: SendResult) => Promise<void>,
  ): Promise<SendResult | undefined>;
  /**
   * Refunds the cap units in `buckets` with `releaseMany` calls of at most 100 inputs,
   * then fills the window when `fill` is true. It never throws.
   */
  releaseAll(entry: Entry, buckets: readonly number[], fill: boolean): Promise<void>;
  /** True when the run goes on to the next provider after its primary attempt. */
  fallsBack(run: MessageRun): boolean;
  /** Stops a run whose claim is lost, with `unknown/stale_pending`. */
  lose(run: MessageRun): void;
  /** The store input of the final record. The run must hold a claim. */
  finishInput(run: MessageRun): IdempotencyFinishInput;
  /** Warns about a final record that did not apply, or that failed (`failed`) with `thrown`. */
  unfinished(run: MessageRun, failed: boolean, thrown?: unknown): void;
  /** Warns about a store failure and returns the result for a message with no attempt. */
  storeError(error: unknown): NotSentResult;
  now(): number;
  reserve(entry: Entry, message: OutgoingMessage, encodedBytes: number): Promise<Gate>;
  refund(entry: Entry, bucketStart: number, result: SendResult): Promise<void>;
  context(entry: Entry): SendContext;
  record(run: MessageRun, entry: Entry, result: SendResult): Promise<void>;
  chain(run: MessageRun, from: number): Promise<void>;
  /** The heartbeat before a provider call. False when the run must stop. It never throws. */
  fence(run: MessageRun): Promise<boolean>;
  /** Stops a run after a store error. */
  fail(run: MessageRun, error: unknown): void;
  /** Writes the final record. It never throws. */
  finish(run: MessageRun): Promise<SendResult>;
  warn(text: string): void;
  /** Accepts one well-formed adapter result. A missing or bad result is `unknown`. */
  check(result: unknown, provider: string): SendResult;
}

/** The warning for a fenced write that did not apply: the claim is lost. */
const LOST_CLAIM = "mailswitch: the claim was no longer current. The record did not change.";

const UNSAFE_SETUP =
  "mailswitch: a provider in the chain has no native idempotency and no idempotency store is set. A keyed send through that provider can go out twice on a retry.";

const SHORT_WINDOW =
  "mailswitch: a provider in the chain keeps an idempotency key for a short time and no idempotency store is set. A keyed retry after that time can go out twice.";

/** True when the provider keeps a key for less time than the store keeps a sent record. */
function shortWindow(entry: Entry): boolean {
  const windowMs = entry.adapter.meta.nativeIdempotencyWindowMs;
  return windowMs !== undefined && windowMs < SENT_RETENTION_MS;
}

function prepareEntries(options: MailerOptions): Entry[] {
  const list = options.providers;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError("createMailer needs at least one provider.");
  }
  const scopes = new Set<string>();
  const rateScopes = new Set<string>();
  return list.map((item: MailerProvider, index) => {
    const adapter = item?.adapter;
    if (typeof adapter?.send !== "function" || typeof adapter.meta?.id !== "string") {
      throw new TypeError(`createMailer: providers[${index}] has no valid adapter.`);
    }
    const id = adapter.meta.id;
    const parsed = checkCredentials(adapter.meta, item.credentials ?? {}, item.preset);
    if (!parsed.ok) {
      const fields = parsed.errors.map((error) => `${error.field} (${error.code})`).join(", ");
      throw new TypeError(`createMailer: provider "${id}" has invalid credentials: ${fields}.`);
    }
    const entry: Entry = {
      adapter,
      credentials: parsed.values,
      defaulted: parsed.defaulted,
      scope: item.scope ?? id,
    };
    const presetCap =
      adapter.meta.presets?.find((p) => p.id === item.preset)?.defaultDailyCap ??
      adapter.meta.defaultDailyCap;
    if (item.dailyCap !== undefined && !options.dailyCaps) {
      throw new TypeError(`createMailer: provider "${id}" has a dailyCap but no dailyCaps store.`);
    }
    const cap = item.dailyCap ?? (options.dailyCaps ? presetCap : undefined);
    if (cap !== undefined) {
      entry.cap = checkDailyCap(cap, `createMailer: provider "${id}"`);
      if (scopes.has(entry.scope)) {
        throw new TypeError(`createMailer: the cap scope "${entry.scope}" is used twice.`);
      }
      scopes.add(entry.scope);
    }
    if (item.rate !== undefined) {
      if (!options.rateLimits) {
        throw new TypeError(`createMailer: provider "${id}" has a rate but no rateLimits store.`);
      }
      entry.rate = checkRate(item.rate, `createMailer: provider "${id}"`);
      if (rateScopes.has(entry.scope)) {
        throw new TypeError(`createMailer: the rate limit scope "${entry.scope}" is used twice.`);
      }
      rateScopes.add(entry.scope);
    }
    return entry;
  });
}

function thrownResult(provider: string): UnknownResult {
  return {
    status: "unknown",
    reason: "provider_error",
    message: "The provider adapter threw an error. The email may have gone out.",
    provider,
  };
}

/** Accepts only a well-formed result from an adapter. Anything else is `unknown`. */
function checkResult(result: unknown, provider: string): SendResult {
  const status = (result as SendResult | null)?.status;
  if (status !== "sent" && status !== "not_sent" && status !== "unknown") {
    return thrownResult(provider);
  }
  const out = result as SendResult;
  return out.provider === undefined ? { ...out, provider } : out;
}

/**
 * Creates a mailer over a provider chain.
 *
 * `SendContext.credentials` holds the field defaults, as `parseCredentials` gives them.
 * `SendContext.defaultedFields` names the fields that got a default. The built-in
 * adapters then use this order: the fixed value of the preset, a value in `credentials`,
 * the adapter option, and the field default. So `smtp({ security: "tls" })` applies when
 * the credentials do not set `security`.
 *
 * When a provider in the chain has no native idempotency and no `idempotency` store is
 * set, `createMailer` writes one warning to the logger. A keyed retry through that
 * provider can then send a second copy. Set an idempotency store to remove the risk. A
 * provider with a `nativeIdempotencyWindowMs` under 7 days gets the same warning.
 *
 * A provider answer with the reason `quota` fills the daily cap of that provider.
 *
 * `sendBatch` uses the batch endpoint of the primary when it has one. A message that the
 * batch endpoint refuses goes through a single send. A batch request carries no native
 * idempotency key, so only the store claim protects a keyed batch message. A keyed batch
 * with no store writes one warning per mailer, on the first such call. After the batch,
 * only the `not_sent` messages go to the fallbacks. A key used twice in one call gives
 * `unknown/in_flight` for the second message.
 *
 * Before each provider call, the claim gets a heartbeat (`IdempotencyStore.touch`). In
 * `send`, the first provider call has no heartbeat, because the claim has just written
 * the same time. `sendBatch` keeps the heartbeat before each provider call. When the
 * claim is lost, for example after a stale conversion and a release, the message makes
 * no further provider call and gets `unknown/stale_pending`.
 *
 * `sendBatch` uses the bulk store methods when a store has them (see `IdempotencyStore`
 * and `DailyCapStore`). It detects the idempotency store and the daily cap store
 * separately. Each bulk call takes at most 100 inputs, which is one store chunk. The
 * first valid copy of each key claims with `claimMany`. A later copy claims on the
 * per-message path. `reserveMany` grants the units of the primary to the first batch
 * messages in input order. `touchMany` runs before each provider chunk. One
 * `releaseMany` call refunds the units of a chunk. `finishMany` writes the final records
 * of the messages with no fallback before the fallbacks run, then the records of the
 * fallback messages. The fallbacks and the single sends use the per-message path.
 *
 * A store failure is a result, not an exception, in `send` and in `sendBatch`. The message
 * stops at the failed store call. It keeps the result of its last attempt, or gets
 * `not_sent/store_error` when no attempt ran. On the per-message path, other messages of
 * a batch keep their results. On the bulk path, a bulk call that throws or that returns
 * a list of the wrong length fails every message of its store chunk. Before a provider
 * call, each of them gets `not_sent/store_error`. The other store chunks go on. When the
 * final record fails to write, the provider result still comes back and the logger gets
 * a warning.
 *
 * @throws TypeError or RangeError for invalid options: no providers, bad credentials, a
 * missing namespace with an idempotency store, or a pending timeout below the floor.
 * `sendBatch` throws a TypeError when its argument is not an array.
 */
export function createMailer(options: MailerOptions): Mailer {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("createMailer expects an options object.");
  }
  const entries = prepareEntries(options);
  const { idempotency, dailyCaps, rateLimits, shouldFallback, onAttempt, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("createMailer: timeoutMs must be a positive number.");
  }
  const pendingTimeoutMs = options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
  const floor = minPendingTimeout(timeoutMs, entries.length);
  if (!(pendingTimeoutMs >= floor)) {
    throw new RangeError(
      `createMailer: pendingTimeoutMs must be at least ${floor} (timeoutMs times the chain length).`,
    );
  }
  const namespace = options.namespace;
  if (idempotency) {
    if (namespace === undefined) {
      throw new TypeError("createMailer: namespace is required with an idempotency store.");
    }
    namespacedKey(namespace, "check");
  }
  if (!idempotency) {
    if (entries.some((entry) => !entry.adapter.meta.nativeIdempotency)) {
      safeWarn(logger, UNSAFE_SETUP);
    } else if (entries.some(shortWindow)) {
      safeWarn(logger, SHORT_WINDOW);
    }
  }
  const clock = options.now ?? Date.now;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function observe(view: AttemptView): Promise<void> {
    if (!onAttempt) return;
    try {
      await onAttempt(view);
    } catch (error) {
      safeWarn(logger, "mailswitch: onAttempt threw. The result does not change.", {
        provider: view.provider,
        error: errorName(error),
      });
    }
  }

  async function refund(entry: Entry, bucketStart: number, result: SendResult): Promise<void> {
    if (!dailyCaps || entry.cap === undefined) return;
    const now = clock();
    try {
      await dailyCaps.release({ scope: entry.scope, bucketStart, now });
      // A daily quota answer from the provider means the account is full for now.
      if (result.status === "not_sent" && result.reason === "quota") {
        await dailyCaps.fill({ scope: entry.scope, cap: entry.cap, now });
      }
    } catch (error) {
      capWarn(entry, error);
    }
  }

  function capWarn(entry: Entry, error: unknown): void {
    safeWarn(logger, "mailswitch: the daily cap store failed to refund or fill.", {
      provider: entry.adapter.meta.id,
      error: errorName(error),
    });
  }

  async function releaseAll(
    entry: Entry,
    buckets: readonly number[],
    fill: boolean,
  ): Promise<void> {
    if (!dailyCaps?.releaseMany || entry.cap === undefined) return;
    const now = clock();
    const { scope, cap } = entry;
    for (const part of chunks(buckets)) {
      try {
        await dailyCaps.releaseMany(part.map((bucketStart) => ({ scope, bucketStart, now })));
      } catch (error) {
        capWarn(entry, error);
      }
    }
    if (!fill) return;
    try {
      await dailyCaps.fill({ scope, cap, now });
    } catch (error) {
      capWarn(entry, error);
    }
  }

  function context(entry: Entry): SendContext {
    const ctx: SendContext = {
      fetch: doFetch,
      timeoutMs,
      credentials: entry.credentials,
      defaultedFields: entry.defaulted,
      now: clock(),
    };
    if (options.connect) ctx.connect = options.connect;
    return ctx;
  }

  /**
   * Takes one rate limit token. Returns a refusal when the bucket is empty. When the
   * store throws or refuses, `release` gives the cap unit of this attempt back first.
   */
  async function limit(
    entry: Entry,
    release?: (result: SendResult) => Promise<void>,
  ): Promise<SendResult | undefined> {
    let refusal: SendResult | undefined;
    try {
      refusal = await acquire(entry);
    } catch (error) {
      await release?.({
        status: "not_sent",
        reason: "rate_limited",
        message: "The rate limit store failed.",
      });
      throw error;
    }
    if (refusal) await release?.(refusal);
    return refusal;
  }

  /** Takes one rate limit token. Returns a refusal when the bucket is empty. */
  async function acquire(entry: Entry): Promise<SendResult | undefined> {
    if (!rateLimits || entry.rate === undefined) return undefined;
    const grant = await rateLimits.acquire({
      scope: entry.scope,
      ratePerSecond: entry.rate.perSecond,
      burst: entry.rate.burst,
      now: clock(),
    });
    if (grant.ok) return undefined;
    return {
      status: "not_sent",
      reason: "rate_limited",
      message: "The rate limit of the provider is reached.",
      retryAfterMs: grant.retryAfterMs,
      provider: entry.adapter.meta.id,
    };
  }

  /**
   * The capability check, the daily cap reserve, and the rate limit. Only a cap or rate
   * limit store failure can throw.
   */
  async function reserve(
    entry: Entry,
    message: OutgoingMessage,
    encodedBytes: number,
  ): Promise<Gate> {
    const { meta } = entry.adapter;
    const refusal = checkCapabilities(message, meta.capabilities, encodedBytes);
    if (refusal) return { refusal: { ...refusal, provider: meta.id } };
    if (!dailyCaps || entry.cap === undefined) {
      const limited = await limit(entry);
      return limited ? { refusal: limited } : {};
    }
    const reservation = await dailyCaps.reserve({
      scope: entry.scope,
      cap: entry.cap,
      now: clock(),
    });
    if (!reservation.ok) return { refusal: capRefusal(meta.id, reservation.resetAt) };
    const { bucketStart } = reservation;
    const limited = await limit(entry, (result) => refund(entry, bucketStart, result));
    return limited ? { refusal: limited } : { bucketStart };
  }

  /** One attempt. Only a cap or rate limit store failure can throw. Adapter errors are results. */
  async function attempt(
    entry: Entry,
    message: OutgoingMessage,
    encodedBytes: number,
  ): Promise<SendResult> {
    const gate = await reserve(entry, message, encodedBytes);
    if (gate.refusal) return gate.refusal;
    const id = entry.adapter.meta.id;
    let result: SendResult;
    try {
      result = checkResult(await entry.adapter.send(message, context(entry)), id);
    } catch {
      result = thrownResult(id);
    }
    if (gate.bucketStart !== undefined && result.status === "not_sent") {
      await refund(entry, gate.bucketStart, result);
    }
    return result;
  }

  /** Warns about a store failure and returns the result for a message with no attempt. */
  function storeError(error: unknown): NotSentResult {
    safeWarn(logger, "mailswitch: a store call failed.", { error: errorName(error) });
    return { status: "not_sent", reason: "store_error", message: "A store call failed." };
  }

  function fail(run: MessageRun, error: unknown): void {
    const result = storeError(error);
    run.done = true;
    run.result ??= result;
  }

  /** Validation and the claim input. Returns a final result, or the prepared message. */
  async function prepare(message: OutgoingMessage): Promise<SendResult | Prepared> {
    const checked = validateMessage(message);
    if (!checked.ok) return checked.result;
    const run: MessageRun = { message, encodedBytes: checked.encodedBytes, attempts: [] };
    const idempotencyKey = message.idempotencyKey;
    if (!idempotency || namespace === undefined || !idempotencyKey) return { run };
    try {
      return { run, claim: await claimInput(namespace, idempotencyKey, message, pendingTimeoutMs) };
    } catch (error) {
      return storeError(error);
    }
  }

  function claimed(prepared: Prepared, outcome: IdempotencyClaimOutcome): SendResult | MessageRun {
    const { run, claim } = prepared;
    if (!claim) return run;
    // A malformed outcome from a custom store throws here. It is a store failure.
    try {
      const begin = claimResult(outcome, claim.key, claim.claimId, claim.payloadHash);
      if (!begin.proceed) return begin.result;
    } catch (error) {
      return storeError(error);
    }
    run.claim = { key: claim.key, claimId: claim.claimId };
    return run;
  }

  async function claim(prepared: Prepared): Promise<SendResult | MessageRun> {
    if (!prepared.claim) return prepared.run;
    let outcome: IdempotencyClaimOutcome;
    try {
      outcome = await (idempotency as IdempotencyStore).claim({ ...prepared.claim, now: clock() });
    } catch (error) {
      return storeError(error);
    }
    return claimed(prepared, outcome);
  }

  /** Validation and the claim. Returns a final result, or the run to go on with. */
  async function start(message: OutgoingMessage): Promise<SendResult | MessageRun> {
    const prepared = await prepare(message);
    return "run" in prepared ? claim(prepared) : prepared;
  }

  /** Appends one attempt to the run and calls the observe hook. */
  async function record(run: MessageRun, entry: Entry, result: SendResult): Promise<void> {
    run.result = result;
    const item: IdempotencyAttempt = {
      provider: entry.adapter.meta.id,
      status: result.status,
      at: clock(),
    };
    if (result.status !== "sent") item.reason = result.reason;
    run.attempts.push(item);
    const view: AttemptView = { ...item };
    if (run.message.idempotencyKey !== undefined) view.messageKey = run.message.idempotencyKey;
    await observe(view);
  }

  /** True when the run goes on to the next provider after its primary attempt. */
  function fallsBack(run: MessageRun): boolean {
    return (
      !run.done &&
      entries.length > 1 &&
      run.result !== undefined &&
      allowFallback(run.result, shouldFallback, logger)
    );
  }

  /**
   * Runs the chain from the entry at `from`. With `from` above 0, the caller checks
   * `fallsBack` first.
   */
  async function chain(run: MessageRun, from: number): Promise<void> {
    if (run.done) return;
    try {
      for (let i = from; i < entries.length; i++) {
        const current = entries[i] as Entry;
        if (!(await fence(run))) return;
        await record(run, current, await attempt(current, run.message, run.encodedBytes));
        if (i === entries.length - 1) break;
        if (!allowFallback(run.result as SendResult, shouldFallback, logger)) break;
      }
    } catch (error) {
      fail(run, error);
    }
  }

  /**
   * The heartbeat of the claim before a provider call. It also writes the attempt that
   * ended since the last heartbeat. A lost claim stops the run with `unknown/stale_pending`
   * and no further record: another request may hold the key now. A store error stops the
   * run as `fail` does. It never throws.
   */
  async function fence(run: MessageRun): Promise<boolean> {
    if (!run.claim) return true;
    // The claim has just written the heartbeat time, so a touch would add nothing.
    if (run.freshClaim && run.attempts.length === 0) return true;
    const last = run.attempts.at(-1);
    try {
      const store = idempotency as IdempotencyStore;
      if (await store.touch({ ...run.claim, now: clock(), attempt: last })) return true;
    } catch (error) {
      fail(run, error);
      return false;
    }
    lose(run);
    return false;
  }

  /**
   * Stops a run whose claim is lost. It makes no further record: another request may hold
   * the key now.
   */
  function lose(run: MessageRun): void {
    run.claim = undefined;
    run.done = true;
    run.result = {
      status: "unknown",
      reason: "stale_pending",
      message: "The claim was lost before the next provider call.",
    };
    safeWarn(logger, LOST_CLAIM, { provider: run.attempts.at(-1)?.provider });
  }

  function finishFor(run: MessageRun): IdempotencyFinishInput {
    const final = run.result as SendResult;
    return finishInput({
      ...(run.claim as NonNullable<MessageRun["claim"]>),
      attempts: run.attempts,
      providerMessageId: final.status === "sent" ? final.providerMessageId : undefined,
      now: clock(),
    });
  }

  function unfinished(run: MessageRun, failed: boolean, thrown?: unknown): void {
    const final = run.result as SendResult;
    // After a throw the record stays pending and goes stale later. The result still counts.
    const text = failed ? "mailswitch: the store failed to write the final record." : LOST_CLAIM;
    const error = failed ? errorName(thrown) : undefined;
    safeWarn(logger, text, { provider: final.provider, status: final.status, error });
  }

  /** Writes the one final record and returns the result of the last attempt. */
  async function finish(run: MessageRun): Promise<SendResult> {
    const final = run.result as SendResult;
    if (!run.claim) return final;
    try {
      if (await (idempotency as IdempotencyStore).finish(finishFor(run))) return final;
      unfinished(run, false);
    } catch (thrown) {
      unfinished(run, true, thrown);
    }
    return final;
  }

  async function send(message: OutgoingMessage): Promise<SendResult> {
    const run = await start(message);
    if (!("attempts" in run)) return run;
    run.freshClaim = true;
    await chain(run, 0);
    return finish(run);
  }

  const steps: PipelineSteps = {
    entries,
    hasStore: idempotency !== undefined,
    start,
    prepare,
    claim,
    claimed,
    bulkClaims: () => (idempotency && hasBulkIdempotency(idempotency) ? idempotency : undefined),
    bulkCaps: () => (dailyCaps && hasBulkDailyCap(dailyCaps) ? dailyCaps : undefined),
    limit,
    releaseAll,
    fallsBack,
    lose,
    finishInput: finishFor,
    unfinished,
    storeError,
    now: clock,
    reserve,
    refund,
    context,
    record,
    chain,
    fence,
    fail,
    finish,
    warn: (text) => safeWarn(logger, text),
    check: checkResult,
  };

  return { send, sendBatch: createBatchSender(steps) };
}
