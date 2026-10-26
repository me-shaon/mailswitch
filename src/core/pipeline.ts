// The send pipeline. The order is fixed:
//   1. Validation.
//   2. One idempotency claim, when a store is set and the message has a key.
//   3. For each provider: capability check, daily cap reserve, send, observe hook.
//      Stop on `sent` or `unknown`. Go on after `not_sent` only when fallback allows it.
//   4. One final record, when there is a claim.
// Every exit after a claim writes a final state.

import { DEFAULT_TIMEOUT_MS, type FetchLike } from "../internal/http";
import type { DailyCapStore, IdempotencyAttempt, IdempotencyStore } from "../stores/types";
import type { ProviderAdapter, ProviderCredentials, SendContext } from "./adapter";
import { checkCapabilities } from "./capabilities";
import { parseCredentials } from "./credentials";
import { checkDailyCap } from "./daily-cap";
import { allowFallback, type ShouldFallback } from "./fallback";
import { type AttemptView, errorName, type MailerLogger, safeWarn } from "./hooks";
import {
  beginIdempotency,
  DEFAULT_PENDING_TIMEOUT_MS,
  finalizeIdempotency,
  minPendingTimeout,
  namespacedKey,
} from "./idempotency";
import { validateMessage } from "./message";
import type { SocketConnect } from "./socket";
import type { OutgoingMessage, SendResult, UnknownResult } from "./types";

/** One provider in the chain. The first entry is the primary. */
export interface MailerProvider {
  adapter: ProviderAdapter;
  /** The raw credentials. `createMailer` checks them with `parseCredentials`. */
  credentials: Readonly<Record<string, unknown>>;
  /** A preset id of the adapter meta. Its fixed values and `defaultDailyCap` apply. */
  preset?: string;
  /**
   * The most sends in a rolling 24 hours. It needs the `dailyCaps` store. It defaults to
   * the `defaultDailyCap` of the preset when a `dailyCaps` store is set.
   */
  dailyCap?: number;
  /** The cap counter name. Defaults to the provider id. Give one per provider account. */
  scope?: string;
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
}

interface Entry {
  adapter: ProviderAdapter;
  credentials: ProviderCredentials;
  cap?: number;
  scope: string;
}

const UNSAFE_SETUP =
  "mailswitch: a provider in the chain has no native idempotency and no idempotency store is set. A keyed send through that provider can go out twice on a retry.";

function prepareEntries(options: MailerOptions): Entry[] {
  const list = options.providers;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError("createMailer needs at least one provider.");
  }
  const scopes = new Set<string>();
  return list.map((item: MailerProvider, index) => {
    const adapter = item?.adapter;
    if (typeof adapter?.send !== "function" || typeof adapter.meta?.id !== "string") {
      throw new TypeError(`createMailer: providers[${index}] has no valid adapter.`);
    }
    const id = adapter.meta.id;
    const parsed = parseCredentials(adapter.meta, item.credentials ?? {}, item.preset);
    if (!parsed.ok) {
      const fields = parsed.errors.map((error) => `${error.field} (${error.code})`).join(", ");
      throw new TypeError(`createMailer: provider "${id}" has invalid credentials: ${fields}.`);
    }
    const entry: Entry = { adapter, credentials: parsed.values, scope: item.scope ?? id };
    const presetCap = adapter.meta.presets?.find((p) => p.id === item.preset)?.defaultDailyCap;
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
 * When a provider in the chain has no native idempotency and no `idempotency` store is
 * set, `createMailer` writes one warning to the logger. A keyed retry through that
 * provider can then send a second copy. Set an idempotency store to remove the risk.
 *
 * A provider answer with the reason `quota` fills the daily cap of that provider.
 *
 * @throws TypeError or RangeError for invalid options: no providers, bad credentials, a
 * missing namespace with an idempotency store, or a pending timeout below the floor.
 */
export function createMailer(options: MailerOptions): Mailer {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("createMailer expects an options object.");
  }
  const entries = prepareEntries(options);
  const { idempotency, dailyCaps, shouldFallback, onAttempt, logger } = options;
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
  if (!idempotency && entries.some((entry) => !entry.adapter.meta.nativeIdempotency)) {
    safeWarn(logger, UNSAFE_SETUP);
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

  /** One attempt. Only a daily cap store failure can throw. Adapter errors are results. */
  async function attempt(
    entry: Entry,
    message: OutgoingMessage,
    encodedBytes: number,
  ): Promise<SendResult> {
    const { meta } = entry.adapter;
    const refusal = checkCapabilities(message, meta.capabilities, encodedBytes);
    if (refusal) return { ...refusal, provider: meta.id };
    let bucketStart: number | undefined;
    if (dailyCaps && entry.cap !== undefined) {
      const reservation = await dailyCaps.reserve({
        scope: entry.scope,
        cap: entry.cap,
        now: clock(),
      });
      if (!reservation.ok) {
        return {
          status: "not_sent",
          reason: "daily_cap",
          message: "The daily cap of the provider is reached.",
          resetAt: reservation.resetAt,
          provider: meta.id,
        };
      }
      bucketStart = reservation.bucketStart;
    }
    const ctx: SendContext = {
      fetch: doFetch,
      timeoutMs,
      credentials: entry.credentials,
      now: clock(),
    };
    if (options.connect) ctx.connect = options.connect;
    let result: SendResult;
    try {
      result = checkResult(await entry.adapter.send(message, ctx), meta.id);
    } catch {
      result = thrownResult(meta.id);
    }
    if (bucketStart !== undefined && result.status === "not_sent") {
      await refund(entry, bucketStart, result);
    }
    return result;
  }

  async function send(message: OutgoingMessage): Promise<SendResult> {
    const checked = validateMessage(message);
    if (!checked.ok) return checked.result;
    let claim: { key: string; claimId: string } | undefined;
    if (idempotency && namespace !== undefined && message.idempotencyKey) {
      const begin = await beginIdempotency(idempotency, namespace, message, {
        now: clock(),
        pendingTimeoutMs,
      });
      if (!begin.proceed) return begin.result;
      claim = { key: begin.key, claimId: begin.claimId };
    }
    const attempts: IdempotencyAttempt[] = [];
    let result: SendResult | undefined;
    try {
      for (let i = 0; i < entries.length; i++) {
        const current = entries[i] as Entry;
        result = await attempt(current, message, checked.encodedBytes);
        const at = clock();
        const record: IdempotencyAttempt = {
          provider: current.adapter.meta.id,
          status: result.status,
          at,
        };
        if (result.status !== "sent") record.reason = result.reason;
        attempts.push(record);
        const view: AttemptView = { ...record };
        if (message.idempotencyKey !== undefined) view.messageKey = message.idempotencyKey;
        await observe(view);
        if (i === entries.length - 1) break;
        if (!allowFallback(result, shouldFallback, logger)) break;
      }
    } catch (error) {
      // The daily cap store failed before a send. Write a final state from the attempts
      // so far, then let the error leave the pipeline.
      if (claim) {
        await finalizeIdempotency(idempotency as IdempotencyStore, {
          ...claim,
          attempts,
          now: clock(),
        });
      }
      throw error;
    }
    const final = result as SendResult;
    if (claim) {
      const done = await finalizeIdempotency(idempotency as IdempotencyStore, {
        ...claim,
        attempts,
        ...(final.status === "sent" && final.providerMessageId !== undefined
          ? { providerMessageId: final.providerMessageId }
          : {}),
        now: clock(),
      });
      if (!done.applied) {
        safeWarn(
          logger,
          "mailswitch: the claim was no longer current. The record did not change.",
          {
            provider: final.provider,
            status: final.status,
          },
        );
      }
    }
    return final;
  }

  return { send };
}
