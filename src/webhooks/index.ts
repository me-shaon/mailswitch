// mailswitch/webhooks: handleWebhook and the normalized event types.
//
// handleWebhook reads the body once as bytes, checks the size cap, and verifies the
// signature over the raw bytes. Only a verified request touches the dedupe store. Dedupe
// has two phases: a claim with a lease, then `ack()`, which commits the keys. An app that
// does not call `ack()` must answer with a non-2xx status, so the provider retries after
// the lease expires.

import type { ProviderAdapter } from "../core/adapter";
import type { NormalizedEvent, WebhookRejection } from "../core/events";
import { type BulkDedupeStore, hasBulkDedupe } from "../internal/bulk-methods";
import { chunks } from "../internal/chunks";
import { sha256Hex } from "../internal/sha256";
import type { DedupeClaimOutcome, DedupeReleaseInput, DedupeStore } from "../stores/types";

export type {
  ProviderWebhooks,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from "../core/adapter";
export type {
  BounceDetail,
  NormalizedEvent,
  NormalizedEventType,
  WebhookRejection,
} from "../core/events";
export type {
  DedupeClaimInput,
  DedupeClaimManyInput,
  DedupeClaimOutcome,
  DedupeCommitInput,
  DedupeCommitManyInput,
  DedupeReleaseInput,
  DedupeStore,
} from "../stores/types";

/** The default claim lease, in milliseconds. */
export const DEFAULT_LEASE_MS: number = 60 * 1000;
/** The default dedupe TTL for a provider that signs a timestamp, in milliseconds. */
export const DEFAULT_DEDUPE_TTL_MS: number = 7 * 24 * 60 * 60 * 1000;
/** The default dedupe TTL for a provider that signs no timestamp, in milliseconds. */
export const UNSIGNED_TIMESTAMP_TTL_MS: number = 30 * 24 * 60 * 60 * 1000;
/** The default body size cap, in bytes. */
export const DEFAULT_MAX_BODY_BYTES: number = 1024 * 1024;

/** The HTTP status that each rejection suggests to the app. */
export const REJECTION_STATUS: Readonly<Record<WebhookRejection, number>> = {
  bad_signature: 401,
  stale: 401,
  untrusted_topic: 401,
  malformed: 400,
  too_large: 413,
  // The app read the body before mailswitch. A 500 makes the provider retry.
  body_used: 500,
  replay: 200,
  in_flight: 409,
  // The secret on this side is wrong. A 500 makes the provider retry after the fix.
  invalid_secret: 500,
};

/** An adapter whose webhooks need a dedupe store, such as the toSend adapter. */
export interface DedupeRequiredAdapter extends ProviderAdapter {
  readonly requiresDedupe: true;
}

/**
 * An adapter whose event keys are bound to the raw body, such as the Mailgun adapter. Its
 * signature does not cover the body, so the router claims each key twice: once alone,
 * and once with the SHA-256 of the body. A key that is claimed or committed with another
 * body is refused as `bad_signature`. `minDedupeTtlMs` is the shortest allowed `ttlMs`.
 */
export interface BodyBoundAdapter extends DedupeRequiredAdapter {
  readonly bodyBoundKeys: true;
  readonly minDedupeTtlMs?: number;
}

/** The options of `handleWebhook`. */
export interface HandleWebhookOptions {
  /** The adapter of the provider that sent the webhook. It must have webhook methods. */
  adapter: ProviderAdapter;
  /** The signing secret of the webhook endpoint. */
  secret: string;
  /**
   * The dedupe store. Without it, every verified event comes back and `ack()` does
   * nothing. It is required for an adapter with `requiresDedupe`.
   */
  dedupe?: DedupeStore;
  /** Separates the keys of two endpoints of one provider. Defaults to `default`. */
  endpointId?: string;
  /** The claim lease, in milliseconds. Defaults to `DEFAULT_LEASE_MS`. */
  leaseMs?: number;
  /**
   * How long a committed key blocks a replay, in milliseconds. Defaults to 7 days, or 30
   * days when the adapter signs no timestamp. A replay after the TTL is delivered again.
   */
  ttlMs?: number;
  /** The body size cap, in bytes. Defaults to `DEFAULT_MAX_BODY_BYTES`. */
  maxBodyBytes?: number;
  /** The clock, in Unix milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/** The options of `handleWebhook` for an adapter that needs a dedupe store. */
export interface HandleWebhookDedupeOptions extends HandleWebhookOptions {
  adapter: DedupeRequiredAdapter;
  dedupe: DedupeStore;
}

/** A verified webhook. Handle the events, then call `ack()`. */
export interface WebhookAccepted {
  ok: true;
  /** The new events. Duplicates are left out, so this list can be empty. */
  events: NormalizedEvent[];
  /** Commits the claimed keys, so a replay is a duplicate. Call it after the events are handled. */
  ack(): Promise<void>;
  /** Frees the claimed keys, so a provider retry delivers the events again. */
  release(): Promise<void>;
}

/** A refused webhook. Answer with `status`. No event was claimed. */
export interface WebhookRefused {
  ok: false;
  rejection: WebhookRejection;
  /** The suggested HTTP status. */
  status: number;
}

/** The outcome of `handleWebhook`. Switch on `ok`. */
export type WebhookOutcome = WebhookAccepted | WebhookRefused;

function refuse(rejection: WebhookRejection): WebhookRefused {
  return { ok: false, rejection, status: REJECTION_STATUS[rejection] };
}

function positive(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`handleWebhook: ${name} must be a positive number.`);
  }
  return value;
}

/** Reads the body up to `max` bytes. It returns null when the body is larger. */
async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  const length = request.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length.trim()) && Number(length) > max) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const NOOP = async (): Promise<void> => undefined;

/** The most keys in one bulk store call. */
const BULK_CHUNK_KEYS = 500;

/** One event with a distinct key. `boundKey` is set only for a body-bound adapter. */
interface DedupeEntry {
  event: NormalizedEvent;
  key: string;
  boundKey: string | undefined;
}

/**
 * The entries of a parsed body, one for each distinct key. One body can repeat a key, and
 * the first copy stands for all of them. For a body-bound adapter, the second key binds
 * the event key to this body.
 */
function dedupeEntries(
  parsed: readonly NormalizedEvent[],
  endpointId: string,
  fingerprint: string | undefined,
): DedupeEntry[] {
  const entries: DedupeEntry[] = [];
  const seen = new Set<string>();
  for (const event of parsed) {
    const key = `${event.provider}:${endpointId}:${event.eventKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const boundKey = fingerprint === undefined ? undefined : `${key}#${fingerprint}`;
    entries.push({ event, key, boundKey });
  }
  return entries;
}

type ClaimStatus = DedupeClaimOutcome["status"];

/**
 * What the claim outcomes of one event mean. The bulk path and the loop path both use it,
 * so they refuse the same requests.
 */
function decide(
  primary: ClaimStatus | undefined,
  bound: ClaimStatus | undefined,
): "emit" | "skip" | "bad_signature" | "in_flight" {
  // A new bound key with an old primary key: another body holds or used this key.
  if (bound === "new" && primary !== "new") return "bad_signature";
  if (primary === "in_flight" || bound === "in_flight") return "in_flight";
  return primary === "new" && (bound === undefined || bound === "new") ? "emit" : "skip";
}

/**
 * Dedupes the entries with the bulk store methods. The result is the same as the loop
 * in `handleWebhook`, but the store gets one claim call for each chunk of keys.
 */
async function bulkDedupe(
  store: BulkDedupeStore,
  entries: readonly DedupeEntry[],
  options: { leaseMs: number; ttlMs: number; now: () => number },
): Promise<WebhookOutcome> {
  // Both keys of one event go in the same chunk.
  const groups: DedupeEntry[][] = [];
  let current: DedupeEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const weight = entry.boundKey === undefined ? 1 : 2;
    if (size + weight > BULK_CHUNK_KEYS) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += weight;
  }
  if (current.length > 0) groups.push(current);

  // Each claimed key keeps its lease id, so a release or a commit touches only this
  // request's lease and never a newer claim of the same key.
  const claimed: DedupeReleaseInput[] = [];
  const releaseAll = async (): Promise<void> => {
    const leases = claimed.splice(0);
    await Promise.all(chunks(leases, BULK_CHUNK_KEYS).map((chunk) => store.releaseMany(chunk)));
  };
  const events: NormalizedEvent[] = [];
  let refusal: WebhookRejection | undefined;
  try {
    for (const chunk of groups) {
      const keys = chunk.flatMap((entry) =>
        entry.boundKey === undefined ? [entry.key] : [entry.key, entry.boundKey],
      );
      const results = await store.claimMany({ keys, leaseMs: options.leaseMs, now: options.now() });
      const outcomes = new Map<string, ClaimStatus>();
      keys.forEach((key, i) => {
        const outcome = results[i];
        if (!outcome) throw new Error("claimMany returned fewer outcomes than keys.");
        outcomes.set(key, outcome.status);
        if (outcome.status === "new") claimed.push({ key, leaseId: outcome.leaseId });
      });
      // Decide after each chunk, in body order, and claim no later chunk after a refusal.
      for (const entry of chunk) {
        const bound = entry.boundKey === undefined ? undefined : outcomes.get(entry.boundKey);
        const decision = decide(outcomes.get(entry.key), bound);
        if (decision === "emit") events.push(entry.event);
        else if (decision !== "skip") {
          refusal = decision;
          break;
        }
      }
      if (refusal !== undefined) break;
    }
  } catch (error) {
    // A failed claimMany claimed no key. Free the leases of the earlier chunks.
    await releaseAll().catch(() => undefined);
    throw error;
  }
  if (refusal !== undefined) {
    await releaseAll();
    return refuse(refusal);
  }
  return {
    ok: true,
    events,
    async ack() {
      const leases = claimed.splice(0);
      const at = options.now();
      // One failed statement rolls back the commits of its chunk. A commit that another
      // lease holds returns false. That newer holder commits it.
      await Promise.all(
        chunks(leases, BULK_CHUNK_KEYS).map((chunk) =>
          store.commitMany({ leases: chunk, ttlMs: options.ttlMs, now: at }),
        ),
      );
    },
    release: releaseAll,
  };
}

/**
 * Verifies a provider webhook, dedupes its events, and returns them in the normalized
 * shape.
 *
 * 1. A used body is refused as `body_used`. A body over the cap is refused as `too_large`
 *    before the signature check.
 * 2. The adapter verifies the signature over the raw bytes.
 * 3. Only after a valid signature, each event key is claimed with a lease. A duplicate is
 *    left out. When another request holds a key, the result is `in_flight` (409), and
 *    the keys of this request are released. When the store has `claimMany`, `commitMany`,
 *    and `releaseMany`, the router claims, commits, and releases the keys in chunks of
 *    500. A failed statement then rolls back the whole commit of its chunk.
 * 4. For an adapter with `bodyBoundKeys`, each key is also claimed with the SHA-256 of the
 *    body. A key that another body holds or used is refused as `bad_signature`.
 *
 * @throws TypeError for a programmer error: an adapter with no webhooks, a missing
 * dedupe store for an adapter with `requiresDedupe`, a `ttlMs` below the adapter
 * `minDedupeTtlMs`, or an invalid option.
 */
export function handleWebhook(
  request: Request,
  options: HandleWebhookDedupeOptions,
): Promise<WebhookOutcome>;
export function handleWebhook(
  request: Request,
  options: HandleWebhookOptions & {
    adapter: ProviderAdapter & { readonly requiresDedupe?: false };
  },
): Promise<WebhookOutcome>;
export function handleWebhook(
  request: Request,
  options: HandleWebhookOptions,
): Promise<WebhookOutcome> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("handleWebhook expects an options object.");
  }
  const { adapter, dedupe } = options;
  const hooks = adapter?.webhooks;
  if (!hooks || typeof hooks.verify !== "function" || typeof hooks.parse !== "function") {
    throw new TypeError("handleWebhook: the adapter has no webhook methods.");
  }
  const id = adapter.meta.id;
  if ((adapter as { requiresDedupe?: unknown }).requiresDedupe === true && !dedupe) {
    throw new TypeError(`handleWebhook: provider "${id}" needs a dedupe store.`);
  }
  if (typeof options.secret !== "string") {
    throw new TypeError("handleWebhook: secret must be a string.");
  }
  const endpointId = options.endpointId ?? "default";
  if (typeof endpointId !== "string" || endpointId === "") {
    throw new TypeError("handleWebhook: endpointId must be a non-empty string.");
  }
  const leaseMs = positive(options.leaseMs, "leaseMs", DEFAULT_LEASE_MS);
  const ttlMs = positive(
    options.ttlMs,
    "ttlMs",
    hooks.signedTimestamp === true ? DEFAULT_DEDUPE_TTL_MS : UNSIGNED_TIMESTAMP_TTL_MS,
  );
  const marks = adapter as { bodyBoundKeys?: unknown; minDedupeTtlMs?: unknown };
  const bodyBound = marks.bodyBoundKeys === true;
  if (typeof marks.minDedupeTtlMs === "number" && ttlMs < marks.minDedupeTtlMs) {
    throw new TypeError(
      `handleWebhook: ttlMs must be at least ${marks.minDedupeTtlMs} for provider "${id}".`,
    );
  }
  const maxBodyBytes = positive(options.maxBodyBytes, "maxBodyBytes", DEFAULT_MAX_BODY_BYTES);
  const now = options.now ?? Date.now;

  return (async (): Promise<WebhookOutcome> => {
    if (request.bodyUsed) return refuse("body_used");
    const body = await readBody(request, maxBodyBytes);
    if (body === null) return refuse("too_large");
    const verified = await hooks.verify({
      headers: request.headers,
      body,
      secret: options.secret,
      now: now(),
    });
    if (!verified.ok) return refuse(verified.reason);
    const parsed = hooks.parse(body, request.headers);
    if (!dedupe) return { ok: true, events: parsed, ack: NOOP, release: NOOP };

    const fingerprint = bodyBound ? sha256Hex(body) : undefined;
    const entries = dedupeEntries(parsed, endpointId, fingerprint);
    if (hasBulkDedupe(dedupe)) return bulkDedupe(dedupe, entries, { leaseMs, ttlMs, now });

    // Each claimed key keeps its lease id, so a release or a commit touches only this
    // request's lease and never a newer claim of the same key.
    const claimed: { key: string; leaseId: string }[] = [];
    const releaseAll = async (): Promise<void> => {
      const leases = claimed.splice(0);
      await Promise.all(leases.map((lease) => dedupe.release(lease)));
    };
    const events: NormalizedEvent[] = [];
    let refusal: WebhookRejection | undefined;
    try {
      for (const { event, key, boundKey } of entries) {
        const first = await dedupe.claim({ key, leaseMs, now: now() });
        if (first.status === "new") claimed.push({ key, leaseId: first.leaseId });
        let bound: ClaimStatus | undefined;
        if (boundKey !== undefined) {
          const boundClaim = await dedupe.claim({ key: boundKey, leaseMs, now: now() });
          if (boundClaim.status === "new") {
            claimed.push({ key: boundKey, leaseId: boundClaim.leaseId });
          }
          bound = boundClaim.status;
        }
        const decision = decide(first.status, bound);
        if (decision === "emit") events.push(event);
        else if (decision !== "skip") {
          refusal = decision;
          break;
        }
      }
    } catch (error) {
      await releaseAll().catch(() => undefined);
      throw error;
    }
    if (refusal !== undefined) {
      await releaseAll();
      return refuse(refusal);
    }
    return {
      ok: true,
      events,
      async ack() {
        const leases = claimed.splice(0);
        const at = now();
        // A commit that another lease holds returns false. That newer holder commits it.
        await Promise.all(leases.map((lease) => dedupe.commit({ ...lease, ttlMs, now: at })));
      },
      release: releaseAll,
    };
  })();
}
