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
// none. A final record that fails to write leaves the claim `pending`. It goes stale later,
// which is the safe direction.

import { DEFAULT_TIMEOUT_MS, type FetchLike } from "../internal/http";
import type {
  DailyCapStore,
  IdempotencyAttempt,
  IdempotencyStore,
  RateLimitStore,
} from "../stores/types";
import type { ProviderAdapter, ProviderCredentials, SendContext } from "./adapter";
import { createBatchSender } from "./batch";
import { checkCapabilities } from "./capabilities";
import { checkCredentials } from "./credentials";
import { checkDailyCap } from "./daily-cap";
import { allowFallback, type ShouldFallback } from "./fallback";
import { type AttemptView, errorName, type MailerLogger, safeWarn } from "./hooks";
import {
  beginIdempotency,
  DEFAULT_PENDING_TIMEOUT_MS,
  finalizeIdempotency,
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
   * message runs its own claim. See `createMailer` for the batch rules.
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
 * Before each provider call, the claim gets a heartbeat (`IdempotencyStore.touch`). When
 * the claim is lost, for example after a stale conversion and a release, the message
 * makes no further provider call and gets `unknown/stale_pending`.
 *
 * A store failure is a result, not an exception, in `send` and in `sendBatch`. The message
 * stops at the failed store call. It keeps the result of its last attempt, or gets
 * `not_sent/store_error` when no attempt ran. Other messages of a batch keep their
 * results. When the final record fails to write, the provider result still comes back
 * and the logger gets a warning.
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
      safeWarn(logger, "mailswitch: the daily cap store failed to refund or fill.", {
        provider: entry.adapter.meta.id,
        error: errorName(error),
      });
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
   * store throws or refuses, the cap unit of this attempt goes back first.
   */
  async function limit(entry: Entry, bucketStart?: number): Promise<SendResult | undefined> {
    if (!rateLimits || entry.rate === undefined) return undefined;
    const id = entry.adapter.meta.id;
    let refusal: SendResult | undefined;
    try {
      const grant = await rateLimits.acquire({
        scope: entry.scope,
        ratePerSecond: entry.rate.perSecond,
        burst: entry.rate.burst,
        now: clock(),
      });
      if (!grant.ok) {
        refusal = {
          status: "not_sent",
          reason: "rate_limited",
          message: "The rate limit of the provider is reached.",
          retryAfterMs: grant.retryAfterMs,
          provider: id,
        };
      }
    } catch (error) {
      if (bucketStart !== undefined) {
        await refund(entry, bucketStart, {
          status: "not_sent",
          reason: "rate_limited",
          message: "The rate limit store failed.",
        });
      }
      throw error;
    }
    if (refusal && bucketStart !== undefined) await refund(entry, bucketStart, refusal);
    return refusal;
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
    if (!reservation.ok) {
      return {
        refusal: {
          status: "not_sent",
          reason: "daily_cap",
          message: "The daily cap of the provider is reached.",
          resetAt: reservation.resetAt,
          provider: meta.id,
        },
      };
    }
    const limited = await limit(entry, reservation.bucketStart);
    if (limited) return { refusal: limited };
    return { bucketStart: reservation.bucketStart };
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

  /** Validation and the claim. Returns a final result, or the run to go on with. */
  async function start(message: OutgoingMessage): Promise<SendResult | MessageRun> {
    const checked = validateMessage(message);
    if (!checked.ok) return checked.result;
    const run: MessageRun = { message, encodedBytes: checked.encodedBytes, attempts: [] };
    if (idempotency && namespace !== undefined && message.idempotencyKey) {
      let begin: Awaited<ReturnType<typeof beginIdempotency>>;
      try {
        begin = await beginIdempotency(idempotency, namespace, message, {
          now: clock(),
          pendingTimeoutMs,
        });
      } catch (error) {
        return storeError(error);
      }
      if (!begin.proceed) return begin.result;
      run.claim = { key: begin.key, claimId: begin.claimId };
    }
    return run;
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

  /**
   * Runs the chain from the entry at `from`. With `from` above 0, the run must hold the
   * result of the entry before it, and the chain goes on only when fallback allows it.
   */
  async function chain(run: MessageRun, from: number): Promise<void> {
    if (run.done) return;
    if (from > 0) {
      if (from >= entries.length) return;
      if (!allowFallback(run.result as SendResult, shouldFallback, logger)) return;
    }
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
    const last = run.attempts.at(-1);
    try {
      const store = idempotency as IdempotencyStore;
      if (await store.touch({ ...run.claim, now: clock(), attempt: last })) return true;
    } catch (error) {
      fail(run, error);
      return false;
    }
    run.claim = undefined;
    run.done = true;
    run.result = {
      status: "unknown",
      reason: "stale_pending",
      message: "The claim was lost before the next provider call.",
    };
    safeWarn(logger, LOST_CLAIM, { provider: last?.provider });
    return false;
  }

  /** Writes the one final record and returns the result of the last attempt. */
  async function finish(run: MessageRun): Promise<SendResult> {
    const final = run.result as SendResult;
    if (!run.claim) return final;
    let text = LOST_CLAIM;
    let error: string | undefined;
    try {
      const done = await finalizeIdempotency(idempotency as IdempotencyStore, {
        ...run.claim,
        attempts: run.attempts,
        providerMessageId: final.status === "sent" ? final.providerMessageId : undefined,
        now: clock(),
      });
      if (done.applied) return final;
    } catch (thrown) {
      // The record stays pending and goes stale later. The provider result still counts.
      text = "mailswitch: the store failed to write the final record.";
      error = errorName(thrown);
    }
    safeWarn(logger, text, { provider: final.provider, status: final.status, error });
    return final;
  }

  async function send(message: OutgoingMessage): Promise<SendResult> {
    const run = await start(message);
    if (!("attempts" in run)) return run;
    await chain(run, 0);
    return finish(run);
  }

  const steps: PipelineSteps = {
    entries,
    hasStore: idempotency !== undefined,
    start,
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
