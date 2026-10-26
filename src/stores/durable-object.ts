// Durable Object stores. A Durable Object runs one event at a time and closes its input
// gate while a storage call runs, so a read and the write after it are atomic.
//
// This file imports no Workers module. The classes use structural types for the state and
// storage, and talk to the clients through `fetch`. Bind both classes in your Worker:
//
//   // src/index.ts
//   export { MailswitchIdempotency, MailswitchLimiter } from "mailswitch/stores/durable-object";
//
//   // wrangler.jsonc
//   "durable_objects": { "bindings": [
//     { "name": "MAILSWITCH_LIMITER", "class_name": "MailswitchLimiter" },
//     { "name": "MAILSWITCH_IDEMPOTENCY", "class_name": "MailswitchIdempotency" }
//   ] },
//   "migrations": [
//     { "tag": "mailswitch-v1", "new_sqlite_classes": ["MailswitchLimiter", "MailswitchIdempotency"] }
//   ]
//
// `MailswitchLimiter` has one object per scope. It holds the token bucket and the rolling
// daily counter of that scope. `MailswitchIdempotency` has one object per key. An alarm
// deletes the record when a `sent` or `not_sent` record expires. The alarm never deletes
// a `pending` or `unknown` record.

import { bucketExpiry, bucketStartOf, windowFloor } from "../core/daily-cap";
import { type TokenBucket, takeToken } from "../core/rate-limit";
import type {
  DailyCapReservation,
  DailyCapStore,
  IdempotencyAppendInput,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyStore,
  RateLimitGrant,
  RateLimitStore,
} from "./types";

export type {
  DailyCapFillInput,
  DailyCapReleaseInput,
  DailyCapReservation,
  DailyCapReserveInput,
  DailyCapStore,
  IdempotencyAppendInput,
  IdempotencyAttempt,
  IdempotencyClaimInput,
  IdempotencyClaimOutcome,
  IdempotencyFinalState,
  IdempotencyFinishInput,
  IdempotencyRecord,
  IdempotencyState,
  IdempotencyStore,
  RateLimitAcquireInput,
  RateLimitGrant,
  RateLimitStore,
} from "./types";

/** The part of the Durable Object storage API that the classes use. */
export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** The part of the Durable Object state that the classes use. */
export interface DurableObjectStateLike {
  readonly storage: DurableObjectStorageLike;
}

/** The part of a Durable Object stub that the clients use. */
export interface DurableObjectStubLike {
  fetch(
    input: string,
    init: { method: string; body: string },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/** The part of a Durable Object namespace binding that the clients use. */
export interface DurableObjectNamespaceLike<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): DurableObjectStubLike;
}

/** The part of a request that the classes read. */
export interface DurableObjectRequestLike {
  readonly url: string;
  json(): Promise<unknown>;
}

const ORIGIN = "https://mailswitch.internal/";

type Body = Record<string, unknown>;

function reply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value ?? null), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Sends one operation to an object. A failed call is an infrastructure error, so it throws. */
async function call<T>(stub: DurableObjectStubLike, op: string, body: Body): Promise<T> {
  const response = await stub.fetch(ORIGIN + op, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) {
    throw new Error(`mailswitch: the Durable Object call "${op}" failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

function checkNamespace(namespace: unknown, name: string): void {
  const ns = namespace as DurableObjectNamespaceLike | null;
  if (typeof ns?.idFromName !== "function" || typeof ns.get !== "function") {
    throw new TypeError(`${name} expects a Durable Object namespace binding.`);
  }
}

// The limiter ------------------------------------------------------------------------------

type Buckets = Record<string, number>;

/** The buckets that are still in the window. It drops the others. */
function inWindow(stored: Buckets | undefined, now: number): Buckets {
  const floor = windowFloor(now);
  const kept: Buckets = {};
  for (const [start, used] of Object.entries(stored ?? {})) {
    if (Number(start) > floor && used > 0) kept[start] = used;
  }
  return kept;
}

function sum(buckets: Buckets): number {
  let used = 0;
  for (const value of Object.values(buckets)) used += value;
  return used;
}

/**
 * The Durable Object of one rate limit and daily cap scope. It holds the token bucket and
 * the rolling daily counter. Bind it and use `durableObjectRateLimitStore` and
 * `durableObjectDailyCapStore` as the clients.
 */
export class MailswitchLimiter {
  readonly #storage: DurableObjectStorageLike;

  constructor(state: DurableObjectStateLike, _env?: unknown) {
    this.#storage = state.storage;
  }

  async fetch(request: DurableObjectRequestLike): Promise<Response> {
    const op = new URL(request.url).pathname.slice(1);
    const body = (await request.json()) as Body;
    const now = body.now as number;
    switch (op) {
      case "acquire":
        return reply(await this.#acquire(body.ratePerSecond as number, body.burst as number, now));
      case "reserve":
        return reply(await this.#reserve(body.cap as number, now));
      case "release":
        await this.#release(body.bucketStart as number, now);
        return reply(null);
      case "fill":
        await this.#fill(body.cap as number, now);
        return reply(null);
      case "used":
        return reply(sum(inWindow(await this.#storage.get<Buckets>("daily"), now)));
      default:
        return reply({ error: "unknown operation" }, 404);
    }
  }

  async #acquire(ratePerSecond: number, burst: number, now: number): Promise<RateLimitGrant> {
    const stored = await this.#storage.get<TokenBucket>("bucket");
    const { bucket, grant } = takeToken(stored, ratePerSecond, burst, now);
    await this.#storage.put("bucket", bucket);
    return grant;
  }

  async #reserve(cap: number, now: number): Promise<DailyCapReservation> {
    const buckets = inWindow(await this.#storage.get<Buckets>("daily"), now);
    if (sum(buckets) >= cap) {
      const oldest = Math.min(...Object.keys(buckets).map(Number));
      return { ok: false, resetAt: bucketExpiry(oldest) };
    }
    const start = bucketStartOf(now);
    buckets[start] = (buckets[start] ?? 0) + 1;
    await this.#storage.put("daily", buckets);
    return { ok: true, bucketStart: start };
  }

  async #release(bucketStart: number, now: number): Promise<void> {
    const buckets = inWindow(await this.#storage.get<Buckets>("daily"), now);
    const used = buckets[bucketStart] ?? 0;
    if (used > 1) buckets[bucketStart] = used - 1;
    else delete buckets[bucketStart];
    await this.#storage.put("daily", buckets);
  }

  async #fill(cap: number, now: number): Promise<void> {
    const buckets = inWindow(await this.#storage.get<Buckets>("daily"), now);
    const missing = cap - sum(buckets);
    if (missing <= 0) return;
    const start = bucketStartOf(now);
    buckets[start] = (buckets[start] ?? 0) + missing;
    await this.#storage.put("daily", buckets);
  }
}

/**
 * A `DailyCapStore` over the `MailswitchLimiter` binding. Each scope is one object, so the
 * daily caps of different providers never wait for each other.
 *
 * @throws TypeError when `namespace` is not a Durable Object namespace binding.
 */
export function durableObjectDailyCapStore<Id>(
  namespace: DurableObjectNamespaceLike<Id>,
): DailyCapStore {
  checkNamespace(namespace, "durableObjectDailyCapStore");
  const stub = (scope: string) => namespace.get(namespace.idFromName(scope));
  return {
    reserve: (input) => call(stub(input.scope), "reserve", { cap: input.cap, now: input.now }),
    release: async (input) => {
      await call(stub(input.scope), "release", { bucketStart: input.bucketStart, now: input.now });
    },
    fill: async (input) => {
      await call(stub(input.scope), "fill", { cap: input.cap, now: input.now });
    },
    used: (scope, now) => call(stub(scope), "used", { now }),
  };
}

/**
 * A `RateLimitStore` over the `MailswitchLimiter` binding. Each scope is one object, so
 * every isolate shares one token bucket per scope.
 *
 * @throws TypeError when `namespace` is not a Durable Object namespace binding.
 */
export function durableObjectRateLimitStore<Id>(
  namespace: DurableObjectNamespaceLike<Id>,
): RateLimitStore {
  checkNamespace(namespace, "durableObjectRateLimitStore");
  return {
    acquire: (input) =>
      call(namespace.get(namespace.idFromName(input.scope)), "acquire", {
        ratePerSecond: input.ratePerSecond,
        burst: input.burst,
        now: input.now,
      }),
  };
}

// Idempotency ------------------------------------------------------------------------------

function expired(record: IdempotencyRecord, now: number): boolean {
  return (
    (record.state === "sent" || record.state === "not_sent") &&
    record.expiresAt !== undefined &&
    record.expiresAt < now
  );
}

/**
 * The Durable Object of one idempotency key. It holds one record. When a record reaches
 * `sent` or `not_sent`, an alarm deletes it after `expiresAt`. Bind it and use
 * `durableObjectIdempotencyStore` as the client.
 */
export class MailswitchIdempotency {
  readonly #storage: DurableObjectStorageLike;

  constructor(state: DurableObjectStateLike, _env?: unknown) {
    this.#storage = state.storage;
  }

  async fetch(request: DurableObjectRequestLike): Promise<Response> {
    const op = new URL(request.url).pathname.slice(1);
    const body = (await request.json()) as Body;
    switch (op) {
      case "claim":
        return reply(await this.#claim(body as unknown as IdempotencyClaimInput));
      case "append":
        return reply(await this.#append(body as unknown as IdempotencyAppendInput));
      case "finish":
        return reply(await this.#finish(body as unknown as IdempotencyFinishInput));
      case "release":
        return reply(await this.#releaseUnknown());
      case "get":
        return reply((await this.#storage.get<IdempotencyRecord>("record")) ?? null);
      case "purge":
        return reply(await this.#purge(body.now as number));
      default:
        return reply({ error: "unknown operation" }, 404);
    }
  }

  /** Deletes an expired `sent` or `not_sent` record. A record that is not due yet gets a new alarm. */
  async alarm(): Promise<void> {
    if (await this.#purge(Date.now())) return;
    const record = await this.#storage.get<IdempotencyRecord>("record");
    if (record && (record.state === "sent" || record.state === "not_sent") && record.expiresAt) {
      await this.#storage.setAlarm(record.expiresAt + 1);
    }
  }

  async #purge(now: number): Promise<boolean> {
    const record = await this.#storage.get<IdempotencyRecord>("record");
    if (!record || !expired(record, now)) return false;
    await this.#storage.delete("record");
    return true;
  }

  async #claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimOutcome> {
    const { key, payloadHash, claimId, now, pendingTimeoutMs } = input;
    const current = await this.#storage.get<IdempotencyRecord>("record");
    const free =
      !current ||
      current.state === "not_sent" ||
      (current.state === "sent" && current.expiresAt !== undefined && current.expiresAt < now);
    if (free) {
      const record: IdempotencyRecord = {
        key,
        payloadHash,
        state: "pending",
        claimId,
        attempts: [],
        claimedAt: now,
        updatedAt: now,
      };
      await this.#storage.put("record", record);
      return { kind: "claimed" };
    }
    let converted = false;
    if (current.state === "pending" && current.claimedAt < now - pendingTimeoutMs) {
      current.state = "unknown";
      current.updatedAt = now;
      await this.#storage.put("record", current);
      converted = true;
    }
    if (current.payloadHash !== payloadHash) return { kind: "conflict", record: current };
    if (converted) return { kind: "stale", record: current };
    if (current.state === "pending") return { kind: "pending", record: current };
    return { kind: "existing", record: current };
  }

  async #fenced(claimId: string): Promise<IdempotencyRecord | undefined> {
    const record = await this.#storage.get<IdempotencyRecord>("record");
    return record && record.claimId === claimId && record.state === "pending" ? record : undefined;
  }

  async #append(input: IdempotencyAppendInput): Promise<boolean> {
    const record = await this.#fenced(input.claimId);
    if (!record) return false;
    record.attempts.push(input.attempt);
    record.updatedAt = input.now;
    await this.#storage.put("record", record);
    return true;
  }

  async #finish(input: IdempotencyFinishInput): Promise<boolean> {
    const record = await this.#fenced(input.claimId);
    if (!record) return false;
    record.state = input.state;
    record.attempts = [...input.attempts];
    record.updatedAt = input.now;
    if (input.providerMessageId !== undefined) record.providerMessageId = input.providerMessageId;
    // Only `sent` and `not_sent` records expire. An `unknown` record stays until a release.
    if (input.state !== "unknown" && input.expiresAt !== undefined) {
      record.expiresAt = input.expiresAt;
      await this.#storage.put("record", record);
      await this.#storage.setAlarm(input.expiresAt + 1);
      return true;
    }
    await this.#storage.put("record", record);
    return true;
  }

  async #releaseUnknown(): Promise<boolean> {
    const record = await this.#storage.get<IdempotencyRecord>("record");
    if (record?.state !== "unknown") return false;
    await this.#storage.delete("record");
    return true;
  }
}

/** The `IdempotencyStore` over the `MailswitchIdempotency` binding. */
export interface DurableObjectIdempotencyStore extends IdempotencyStore {
  /**
   * Deletes the record of one key when it is an expired `sent` or `not_sent` record. The
   * alarm runs the same check. Returns true when it deleted the record.
   */
  purgeKey(key: string, now: number): Promise<boolean>;
}

/**
 * An `IdempotencyStore` over the `MailswitchIdempotency` binding. Each key is one object.
 *
 * Alarms delete expired records, so `purgeExpired` has nothing to do: it returns 0. A
 * client cannot list the objects of a namespace. Use `purgeKey` for one known key.
 *
 * @throws TypeError when `namespace` is not a Durable Object namespace binding.
 */
export function durableObjectIdempotencyStore<Id>(
  namespace: DurableObjectNamespaceLike<Id>,
): DurableObjectIdempotencyStore {
  checkNamespace(namespace, "durableObjectIdempotencyStore");
  const stub = (key: string) => namespace.get(namespace.idFromName(key));
  return {
    claim: (input) => call(stub(input.key), "claim", { ...input }),
    appendAttempt: (input) => call(stub(input.key), "append", { ...input }),
    finish: (input) => call(stub(input.key), "finish", { ...input }),
    release: async (key, options) => {
      if (options?.expectedState !== "unknown") {
        throw new TypeError("release only frees a key in the unknown state.");
      }
      return call(stub(key), "release", {});
    },
    get: (key) => call(stub(key), "get", {}),
    purgeExpired: async () => 0,
    purgeKey: (key, now) => call(stub(key), "purge", { now }),
  };
}
