# Delivery safety

Last checked: 2026-10-26

This guide tells you how mailswitch decides whether an email went out, and how it stops a retry from sending a second copy. Read it before you build retries, a job queue, or an operator screen on top of mailswitch.

## Contents

1. [The three statuses](#the-three-statuses)
2. [Status table](#status-table)
3. [Why fetch errors are unknown](#why-fetch-errors-are-unknown)
4. [The send pipeline](#the-send-pipeline)
5. [Fallback](#fallback)
6. [Idempotency record lifecycle](#idempotency-record-lifecycle)
7. [The namespace option](#the-namespace-option)
8. [Deterministic message bytes](#deterministic-message-bytes)
9. [Release an unknown key](#release-an-unknown-key)
10. [Purge old records](#purge-old-records)
11. [The unsafe setup warning](#the-unsafe-setup-warning)

## The three statuses

| Status | Meaning | What your app does |
|---|---|---|
| `sent` | The provider accepted the email. | Record the provider message ID. |
| `not_sent` | The email did not go out. | Retry later, or show the reason. A retry cannot send a duplicate. |
| `unknown` | The email may have gone out. | Do not retry. Ask a person to check with the provider. |

The rule: **never retry or fall back after `unknown`.** mailswitch never does it. Your app must not do it either, for example in a queue consumer that retries every failure.

A provider failure is a result, not an exception. mailswitch throws only for a programmer error, such as invalid options or bad credentials passed to `createMailer`.

## Status table

The classifier turns each provider answer into a status and a reason. These are the defaults. The [classifier tests](../../test/core/classify.test.ts) check every row.

| Outcome | Status | Reason |
|---|---|---|
| HTTP 2xx | `sent` | none |
| HTTP 400, 413, 415, 422 | `not_sent` | `invalid_message` |
| HTTP 401, 403 | `not_sent` | `auth` |
| HTTP 402 | `not_sent` | `credits` |
| HTTP 429 | `not_sent` | `rate_limited`, with `retryAfterMs` from `Retry-After` |
| Any other HTTP 4xx | `not_sent` | `rejected` |
| HTTP 5xx | `unknown` | `provider_error` |
| Any other HTTP status, such as 3xx | `unknown` | `provider_error` |
| Timeout after the request started | `unknown` | `timeout` |
| Any other error that `fetch` throws | `unknown` | `network` |

A provider can override one HTTP code in the `statusMap` of its meta. Each override must cite the provider documentation that proves it, and an override can never give `sent`. For example, Resend maps 409 to `unknown/idempotency_conflict`. The provider guides list the overrides: [Resend](../providers/resend.md#status-mapping) and [toSend](../providers/tosend.md#status-mapping).

An adapter can refine the reason of a `not_sent` result from the response body, for example `auth` to `credits`. It cannot change `unknown` to `not_sent`.

mailswitch refuses some messages before any network call. These results are always safe to retry after you fix the cause:

| Refusal | Status | Reason |
|---|---|---|
| The message breaks a validation rule | `not_sent` | `invalid_message` |
| The provider cannot send the message, for example it is too large | `not_sent` | `unsupported` |
| The daily cap of the provider is reached | `not_sent` | `daily_cap`, with `resetAt` |
| A store call failed before any provider call for the message | `not_sent` | `store_error` |

The idempotency store can also answer before any network call:

| Store answer | Status | Reason |
|---|---|---|
| The key is `sent` with the same message | `sent` | none. The stored provider and message ID come back. |
| Another request holds the claim now | `unknown` | `in_flight` |
| A claim did not finish in time | `unknown` | `stale_pending` |
| The claim of this send was lost before a fallback call | `unknown` | `stale_pending` |
| The key ended as `unknown` before | `unknown` | The reason of the earlier attempt |
| The key was used with a different message | `unknown` | `idempotency_conflict` |

The last row is `unknown` because a record for the key means that an email for it is pending, sent, or possibly sent.

Two more cases give `unknown/provider_error`: an adapter that throws, and an adapter that returns a malformed result.

## Why fetch errors are unknown

In Workers, `fetch` throws the same `TypeError` for a DNS failure and for a connection reset after the request body went out. mailswitch cannot tell whether the provider got the request. The safe answer is `unknown/network`.

A timeout is the same. The request started, so the provider may have accepted the email before the answer was lost.

This means that the fallback runs less often during network faults. That is the price of no duplicates.

## The send pipeline

`mailer.send(message)` runs these steps in a fixed order:

1. **Validation.** A message that breaks a rule returns `not_sent/invalid_message`. No provider runs.
2. **One idempotency claim.** This step runs only when the mailer has an `idempotency` store and the message has an `idempotencyKey`. A claim that does not proceed returns the store answer from the table above.
3. **The provider chain.** For each provider, in order:
   1. The claim heartbeat, when step 2 made a claim. See [Claim heartbeat](#claim-heartbeat).
   2. The capability check.
   3. The daily cap reserve, when the provider has a cap.
   4. The rate limit, when the provider has a rate.
   5. The send.
   6. The `onAttempt` observe hook.
4. **One final record.** This step runs only when step 2 made a claim.

The chain stops on `sent` or `unknown`. It goes on to the next provider only after `not_sent`.

The cap reserve comes after the claim, so a duplicate retry uses no cap. A `not_sent` result refunds the reserved unit. A `sent` or `unknown` result keeps it. For a provider with a cap, an answer with the reason `quota` fills the cap counter. Later sends then skip that provider until the window has room.

Every exit after a claim writes a final state, except after a lost claim.

### Store failures

A store failure is a result, not an exception. The rule is the same for `send` and `sendBatch`:

- The message stops at the failed store call. It makes no further provider call.
- When the message had no attempt yet, the result is `not_sent/store_error`. No email went out, so a retry is safe.
- When the message had an attempt, the result is the result of its last attempt.
- In `sendBatch`, the other messages go on and keep their results. A cap unit that a stopped message reserved goes back.
- mailswitch writes the final record from the attempts so far. The logger gets a warning with the error name only.

The final record can also fail to write after the provider answered. Then the provider result still comes back, and the logger gets a warning. The record stays `pending`, and it goes stale after the pending timeout. A retry gets `unknown`, so a stale record cannot cause a duplicate.

The `onAttempt` hook gets a redacted view: the provider ID, the status, the reason, the time, and the message key. It never gets recipients, the subject, bodies, attachments, or credentials. A hook error is caught and logged. It cannot change the result.

`mailer.sendBatch(messages)` runs the same steps for each message. See the JSDoc of `createMailer` for the batch rules.

## Fallback

The default rule falls back after `not_sent` and never after `sent` or `unknown`.

`shouldFallback` can narrow the rule. For example, this rule falls back only for a provider outage, and not for a message that the provider refused:

```ts
import { createMailer } from "mailswitch";
import { resend } from "mailswitch/resend";
import { tosend } from "mailswitch/tosend";

declare const env: { RESEND_API_KEY: string; TOSEND_API_KEY: string };

const mailer = createMailer({
  providers: [
    { adapter: resend(), credentials: { apiKey: env.RESEND_API_KEY } },
    { adapter: tosend(), credentials: { apiKey: env.TOSEND_API_KEY } },
  ],
  shouldFallback: (result) => result.reason !== "rejected",
});
```

`shouldFallback` cannot widen the rule. A `true` answer for an `unknown` result is ignored, and the logger gets a warning. A `shouldFallback` that throws counts as `false`.

## Idempotency record lifecycle

One record per key covers the whole provider chain. The record holds no PII: only the key, a payload hash, the state, the attempts, and the provider message ID. Each attempt holds the provider ID, the status, the reason, and the time.

| State | How the record gets it | Can the key send again? | Expires |
|---|---|---|---|
| `pending` | The claim. It stays `pending` until the last attempt ends. | No. A repeat gets `unknown/in_flight`. | Never |
| `sent` | At least one attempt is `sent`. | No. A repeat gets the stored `sent` result. | 7 days after the send |
| `not_sent` | Every attempt is `not_sent`, or no attempt ran. | Yes, at once. The next claim takes the key. | 1 day after the send |
| `unknown` | No attempt is `sent` and at least one is `unknown`. Or a `pending` record went stale. | No, until an operator releases it. | Never |

A `pending` record goes stale when its last write (the claim or a heartbeat) is older than the pending timeout. The default is 10 minutes (`DEFAULT_PENDING_TIMEOUT_MS`). The first claim after the timeout changes the record to `unknown` and gets `unknown/stale_pending`. An expired claim means "possibly sent", so mailswitch never takes it over.

The pending timeout must be at least the request timeout multiplied by the chain length (`minPendingTimeout`). A smaller value throws a `RangeError` in `createMailer`.

Each claim writes a random claim ID. The final record is written only where the claim ID matches and the state is still `pending`. This stops a slow Worker from overwriting a record after a stale conversion and a release.

### Claim heartbeat

Before each provider call, mailswitch calls `IdempotencyStore.touch`. The call sets `updatedAt` to the current time, and it writes the attempt that ended since the last call. It applies only where the claim ID matches and the state is still `pending`.

- The stale check measures from `updatedAt`, not from the claim time. A long `sendBatch` therefore keeps the claims of its later messages current.
- When `touch` returns `false`, the claim is lost. For example, a retry found it stale and an operator released the key. The message then makes no further provider call. It gets `unknown/stale_pending`, and mailswitch writes no further record for it. The logger gets a warning.
- The attempts reach the record while the chain runs. So a record that went stale shows which providers ran before it went stale.

A `sent` record blocks a repeat for 7 days. After that time, `purgeExpired` can delete it, and a retry with the same key sends again.

## The namespace option

`createMailer` requires a `namespace` when it has an `idempotency` store. The store key is `<namespace>:<idempotencyKey>`.

- Choose a stable string for your app, such as `"plainbooks"`. It cannot be empty or contain a colon.
- The namespace does not depend on the provider chain. A deployer who switches from Resend to toSend keeps the same namespace, and the old keys still protect against duplicates.
- **Changing the namespace frees every key.** A retry of an old job after the change can send a second copy.
- Two apps that share one D1 database must use two namespaces.

## Deterministic message bytes

Each key binds a payload hash. The hash is a SHA-256 over the from address, the recipients, the subject, the bodies, the custom headers, and a digest of each attachment. A retry with the same key and a different hash gets `unknown/idempotency_conflict` and makes no network call.

So the message for one key must have the same bytes on every retry. Watch for these sources of change:

- **Generated PDFs.** Many PDF libraries write the creation time or a random document ID into the file. Set a fixed creation date and a fixed ID, for example from the invoice record. Or generate the PDF once, store it in R2, and attach the stored bytes on every retry.
- **Times in the body**, such as "Sent at 10:42". Take the time from the record, not from the clock.
- **Data that changes between retries**, such as a balance. Build the message from a snapshot.

A base64 string and the same raw bytes give the same digest, so the attachment encoding can change.

When the content must change, for example a corrected invoice, use a new key such as `invoice:INV-0042:send:2`.

## Release an unknown key

An `unknown` key stays blocked until an operator releases it. Release a key only when you know that the email did not go out.

1. Read the record with `store.get(key)`. Use the full store key: `<namespace>:<idempotencyKey>`.
2. Note the provider of each attempt and the time.
3. Check the logs or the dashboard of each provider for an email at that time. Use the provider message ID when the record has one.
4. If the email went out, do not release the key. Mark the job as sent in your app.
5. If the email did not go out, release the key:

   ```ts
   import { D1IdempotencyStore } from "mailswitch/stores/d1";

   declare const env: { DB: D1Database };

   const store = new D1IdempotencyStore(env.DB);
   const freed = await store.release("plainbooks:invoice:INV-0042:send:1", {
     expectedState: "unknown",
   });
   ```

6. Send the email again with the same key.

`release` frees only an `unknown` key, and it returns `false` for any other state. You cannot release a `pending` key. Wait for the pending timeout first.

## Purge old records

The send path never deletes records. Call `purgeExpired` from a scheduled handler, for example once a day:

```ts
import { D1DedupeStore, D1IdempotencyStore } from "mailswitch/stores/d1";

interface Env {
  DB: D1Database;
}

export default {
  async scheduled(_controller, env) {
    const now = Date.now();
    await new D1IdempotencyStore(env.DB).purgeExpired(now);
    await new D1DedupeStore(env.DB).purgeExpired(now);
  },
} satisfies ExportedHandler<Env>;
```

`IdempotencyStore.purgeExpired` deletes only expired `sent` and `not_sent` records. It never deletes `pending` or `unknown` records, so an operator can always find them. The D1 daily cap store deletes its old buckets during each reserve, so it needs no purge.

## The unsafe setup warning

A provider with no native idempotency, such as toSend, cannot drop a repeated request. Without a store, a retry after a timeout can send a second copy.

When a provider in the chain has no native idempotency and the mailer has no `idempotency` store, `createMailer` writes this warning to the `logger`:

> mailswitch: a provider in the chain has no native idempotency and no idempotency store is set. A keyed send through that provider can go out twice on a retry.

The warning also matters when only the fallback lacks native idempotency. The key of the primary does not protect the fallback, so set a store for every chain that sends keyed email.
