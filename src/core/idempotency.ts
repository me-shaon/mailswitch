import type {
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinalState,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyStore,
} from "../stores/types";
import { payloadHash } from "./payload-hash";
import type { OutgoingMessage, SendResult, UnknownResult } from "./types";

// The idempotency guard. The pipeline calls `begin` once before the provider chain and
// `finalize` once after it. The record stays `pending` between the two calls.
//
// Result mapping when `begin` does not proceed:
// - `sent` record with the same payload: the stored `sent` result. No network call.
// - `pending` record: `unknown/in_flight`. Another request holds the claim.
// - stale `pending` record (converted by this call): `unknown/stale_pending`.
// - `unknown` record: `unknown` with the reason and provider of the last `unknown` attempt.
//   A record with no `unknown` attempt went stale earlier, so the reason is `stale_pending`.
// - a record with a different payload hash: `unknown/idempotency_conflict`.

/** The default time after which a `pending` record is stale: 10 minutes. */
export const DEFAULT_PENDING_TIMEOUT_MS = 600_000;
/** How long a `sent` record blocks a repeat: 7 days. A retry after this time sends again. */
export const SENT_RETENTION_MS: number = 7 * 24 * 60 * 60 * 1000;
/** How long a `not_sent` record stays for inspection: 1 day. The key is free during this time. */
export const NOT_SENT_RETENTION_MS: number = 24 * 60 * 60 * 1000;

/**
 * The smallest pending timeout that is safe for a chain: the adapter timeout multiplied by
 * the chain length. A smaller timeout could mark a running send as stale.
 */
export function minPendingTimeout(adapterTimeoutMs: number, chainLength: number): number {
  return adapterTimeoutMs * Math.max(1, chainLength);
}

/**
 * The stored key for an idempotency key: `${namespace}:${idempotencyKey}`.
 *
 * @throws TypeError when the namespace is empty or contains a colon.
 */
export function namespacedKey(namespace: string, idempotencyKey: string): string {
  if (typeof namespace !== "string" || namespace === "" || namespace.includes(":")) {
    throw new TypeError("The idempotency namespace must be a non-empty string with no colon.");
  }
  return `${namespace}:${idempotencyKey}`;
}

/** Options for `beginIdempotency`. */
export interface BeginOptions {
  /** Unix milliseconds. Defaults to `Date.now()`. */
  now?: number;
  /** Defaults to `DEFAULT_PENDING_TIMEOUT_MS`. */
  pendingTimeoutMs?: number;
}

/** The outcome of `beginIdempotency`. */
export type BeginResult =
  | { proceed: true; key: string; claimId: string; payloadHash: string }
  | { proceed: false; result: SendResult };

function unknown(reason: UnknownResult["reason"], message: string): UnknownResult {
  return { status: "unknown", reason, message };
}

function lastAttempt(
  record: IdempotencyRecord,
  status: IdempotencyAttempt["status"],
): IdempotencyAttempt | undefined {
  for (let i = record.attempts.length - 1; i >= 0; i--) {
    const attempt = record.attempts[i] as IdempotencyAttempt;
    if (attempt.status === status) return attempt;
  }
  return undefined;
}

/** The result that a repeat gets for a finished record. */
function storedResult(record: IdempotencyRecord): SendResult {
  if (record.state === "sent") {
    const result: SendResult = { status: "sent" };
    if (record.providerMessageId !== undefined) result.providerMessageId = record.providerMessageId;
    const provider = lastAttempt(record, "sent")?.provider;
    if (provider !== undefined) result.provider = provider;
    return result;
  }
  const attempt = lastAttempt(record, "unknown");
  const result = unknown(
    attempt?.reason ?? "stale_pending",
    "An earlier send with this idempotency key may have gone out. Confirm with the provider before a release.",
  );
  if (attempt) result.provider = attempt.provider;
  return result;
}

/**
 * The claim input of a keyed message, without the time. Internal.
 *
 * @throws TypeError when the namespace is invalid.
 */
export async function claimInput(
  namespace: string,
  idempotencyKey: string,
  message: OutgoingMessage,
  pendingTimeoutMs: number,
): Promise<Omit<IdempotencyClaimInput, "now">> {
  const key = namespacedKey(namespace, idempotencyKey);
  const hash = await payloadHash(message);
  return { key, payloadHash: hash, claimId: crypto.randomUUID(), pendingTimeoutMs };
}

/**
 * Claims the idempotency key of a message before the provider chain runs.
 *
 * @throws TypeError when the message has no idempotency key or the namespace is invalid.
 */
export async function beginIdempotency(
  store: IdempotencyStore,
  namespace: string,
  message: OutgoingMessage,
  options: BeginOptions = {},
): Promise<BeginResult> {
  const idempotencyKey = message.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey === "") {
    throw new TypeError("beginIdempotency needs a message with an idempotency key.");
  }
  const input = await claimInput(
    namespace,
    idempotencyKey,
    message,
    options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS,
  );
  const outcome = await store.claim({ ...input, now: options.now ?? Date.now() });
  return claimResult(outcome, input.key, input.claimId, input.payloadHash);
}

/** Maps the outcome of a claim to a begin result. Internal. */
export function claimResult(
  outcome: IdempotencyClaimOutcome,
  key: string,
  claimId: string,
  hash: string,
): BeginResult {
  switch (outcome.kind) {
    case "claimed":
      return { proceed: true, key, claimId, payloadHash: hash };
    case "conflict":
      return {
        proceed: false,
        result: unknown(
          "idempotency_conflict",
          "The idempotency key was used before with a different message.",
        ),
      };
    case "pending":
      return {
        proceed: false,
        result: unknown("in_flight", "Another request holds a claim for this idempotency key."),
      };
    case "stale":
      return {
        proceed: false,
        result: unknown(
          "stale_pending",
          "An earlier claim for this idempotency key did not finish in time. It may have gone out.",
        ),
      };
    case "existing":
      return { proceed: false, result: storedResult(outcome.record) };
  }
}

/**
 * The final state for a list of attempts: `sent` when any attempt is `sent`, else
 * `unknown` when any attempt is `unknown`, else `not_sent`. No attempt gives `not_sent`.
 */
export function finalState(attempts: readonly IdempotencyAttempt[]): IdempotencyFinalState {
  if (attempts.some((attempt) => attempt.status === "sent")) return "sent";
  if (attempts.some((attempt) => attempt.status === "unknown")) return "unknown";
  return "not_sent";
}

/** The input of `finalizeIdempotency`. */
export interface FinalizeInput {
  key: string;
  claimId: string;
  attempts: readonly IdempotencyAttempt[];
  providerMessageId?: string;
  /** Unix milliseconds. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Writes the final record for a claim. `applied` is false when the claim is no longer
 * current, for example after a stale conversion and a release. Then nothing changes.
 */
export async function finalizeIdempotency(
  store: IdempotencyStore,
  input: FinalizeInput,
): Promise<{ applied: boolean; state: IdempotencyFinalState }> {
  const finish = finishInput(input);
  const applied = await store.finish(finish);
  return { applied, state: finish.state };
}

/** The store input of the final record for a claim. Internal. */
export function finishInput(input: FinalizeInput): IdempotencyFinishInput {
  const now = input.now ?? Date.now();
  const state = finalState(input.attempts);
  return {
    key: input.key,
    claimId: input.claimId,
    state,
    attempts: input.attempts,
    ...(state === "sent" && input.providerMessageId !== undefined
      ? { providerMessageId: input.providerMessageId }
      : {}),
    now,
    ...(state === "sent" ? { expiresAt: now + SENT_RETENTION_MS } : {}),
    ...(state === "not_sent" ? { expiresAt: now + NOT_SENT_RETENTION_MS } : {}),
  };
}
