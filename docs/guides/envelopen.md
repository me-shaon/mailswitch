# Move Envelopen to mailswitch

Last checked: 2026-10-26

This guide moves a Workers email marketing app, such as Envelopen, from `@envelopen/providers` to mailswitch. The app keeps its campaign logic, its contact lists, and its unsubscribe pages. mailswitch replaces only the provider layer.

Read [Delivery safety](delivery-safety.md) first. This guide uses its terms.

## Contents

1. [What changes](#what-changes)
2. [Send a campaign batch](#send-a-campaign-batch)
3. [Idempotency keys per message](#idempotency-keys-per-message)
4. [Rate limits and the Durable Object classes](#rate-limits-and-the-durable-object-classes)
5. [Failure reason renames](#failure-reason-renames)
6. [List-Unsubscribe](#list-unsubscribe)
7. [Re-encrypt the stored credentials](#re-encrypt-the-stored-credentials)
8. [Webhooks](#webhooks)
9. [Migration order](#migration-order)
10. [Checklist](#checklist)

## What changes

| Area | `@envelopen/providers` | mailswitch |
|---|---|---|
| Batch send | The adapter batch call | `mailer.sendBatch()` with fully built messages |
| Idempotency key | One key per batch | One key per message |
| Rate limit and daily counter | The app's own Durable Objects | `MailswitchLimiter` and `MailswitchIdempotency` |
| Failure reasons | `validation`, `server_error` | `invalid_message`, `provider_error`, and new reasons |
| List-Unsubscribe | A provider option | A custom header on each message |
| Stored credentials | The Envelopen envelope format | The `mailswitch/crypto` envelope format |
| SES topic allowlist | An adapter option | The `secret` of `handleWebhook` |
| Mailgun and Postmark webhooks | Dedupe optional | Dedupe store required |

Import each provider from its own subpath: `mailswitch/resend`, `mailswitch/postmark`, `mailswitch/ses`, `mailswitch/mailgun`, `mailswitch/cloudflare`, or `mailswitch/smtp`. The Brevo SMTP webhooks are in `mailswitch/smtp/brevo`.

## Send a campaign batch

`sendBatch()` takes fully built messages. mailswitch renders no templates and merges no recipient variables. Render the subject and the body of each message in the app, then give the list to `sendBatch()`.

The call returns one result per message, in input order. Write each result to the row of that recipient.

```ts
import { createMailer, type OutgoingMessage, type SendResult } from "mailswitch";
import { postmark } from "mailswitch/postmark";
import { durableObjectIdempotencyStore } from "mailswitch/stores/durable-object";

interface Env {
  MAILSWITCH_IDEMPOTENCY: DurableObjectNamespace;
  POSTMARK_SERVER_TOKEN: string;
}
interface Recipient {
  id: string;
  email: string;
  html: string;
  unsubscribeUrl: string;
}
declare function saveResult(recipientId: string, result: SendResult): Promise<void>;

export async function sendCampaignChunk(
  env: Env,
  campaignId: string,
  subject: string,
  recipients: readonly Recipient[],
): Promise<void> {
  const mailer = createMailer({
    providers: [{ adapter: postmark(), credentials: { serverToken: env.POSTMARK_SERVER_TOKEN } }],
    namespace: "envelopen",
    idempotency: durableObjectIdempotencyStore(env.MAILSWITCH_IDEMPOTENCY),
  });

  const messages: OutgoingMessage[] = recipients.map((recipient) => ({
    from: { email: "news@studio.example", name: "Studio One" },
    to: [{ email: recipient.email }],
    subject,
    html: recipient.html,
    headers: {
      "List-Unsubscribe": `<${recipient.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    idempotencyKey: `campaign:${campaignId}:recipient:${recipient.id}`,
  }));

  const results = await mailer.sendBatch(messages);
  for (const [index, result] of results.entries()) {
    const recipient = recipients[index];
    if (recipient) await saveResult(recipient.id, result);
  }
}
```

- The batch uses the batch endpoint of the primary when it has one. Postmark takes 500 messages per request, Resend and toSend take 50, and SMTP sends 50 on one connection.
- A message that the batch endpoint cannot take goes through a single send. For example, a Resend batch takes no attachments.
- After the batch, only the `not_sent` messages go to the fallbacks. An `unknown` message never goes to a fallback, and the app must not send it again.

## Idempotency keys per message

`@envelopen/providers` gave one idempotency key to a whole batch. mailswitch gives one key to each message.

- A batch request sends no native idempotency key to the provider. Only the store claim protects each message.
- So set an `idempotency` store for every batch. A keyed batch with no store writes one warning to the logger.
- Build the key from the campaign and the recipient, for example `campaign:<campaign id>:recipient:<recipient id>`. A retry of the chunk then skips every message that already has a record.
- A key used twice in one call gives `unknown/in_flight` for the second message. Remove duplicate recipients before the call.
- The message bytes for one key must be the same on every retry. Render the body from stored data, not from the current time. See [deterministic message bytes](delivery-safety.md#deterministic-message-bytes).

## Rate limits and the Durable Object classes

mailswitch has two Durable Object classes. They replace the rate limiter and the daily counter of Envelopen.

| Class | One object per | Holds |
|---|---|---|
| `MailswitchLimiter` | Scope (provider account) | The token bucket and the rolling daily counter |
| `MailswitchIdempotency` | Idempotency key | One idempotency record. An alarm deletes it after it expires. |

1. Export both classes from the Worker entry:

   ```ts
   // src/index.ts
   export { MailswitchIdempotency, MailswitchLimiter } from "mailswitch/stores/durable-object";
   ```

2. Bind them in `wrangler.jsonc`. Use a new migration tag:

   ```jsonc
   "durable_objects": { "bindings": [
     { "name": "MAILSWITCH_LIMITER", "class_name": "MailswitchLimiter" },
     { "name": "MAILSWITCH_IDEMPOTENCY", "class_name": "MailswitchIdempotency" }
   ] },
   "migrations": [
     { "tag": "mailswitch-v1", "new_sqlite_classes": ["MailswitchLimiter", "MailswitchIdempotency"] }
   ]
   ```

3. Give each provider entry a `rate` and a `dailyCap`, and give the mailer the stores:

   ```ts
   import { connect } from "cloudflare:sockets";
   import { createMailer, type Mailer } from "mailswitch";
   import { smtp } from "mailswitch/smtp";
   import {
     durableObjectDailyCapStore,
     durableObjectIdempotencyStore,
     durableObjectRateLimitStore,
   } from "mailswitch/stores/durable-object";

   interface Env {
     MAILSWITCH_LIMITER: DurableObjectNamespace;
     MAILSWITCH_IDEMPOTENCY: DurableObjectNamespace;
     BREVO_SMTP_LOGIN: string;
     BREVO_SMTP_KEY: string;
   }

   export function campaignMailer(env: Env, connectionId: string): Mailer {
     return createMailer({
       providers: [
         {
           adapter: smtp(),
           preset: "brevo",
           credentials: { username: env.BREVO_SMTP_LOGIN, password: env.BREVO_SMTP_KEY },
           // One scope per connection, so two Brevo accounts get two buckets.
           scope: `brevo:${connectionId}`,
           rate: { perSecond: 5, burst: 10 },
           dailyCap: 300,
         },
       ],
       namespace: "envelopen",
       idempotency: durableObjectIdempotencyStore(env.MAILSWITCH_IDEMPOTENCY),
       dailyCaps: durableObjectDailyCapStore(env.MAILSWITCH_LIMITER),
       rateLimits: durableObjectRateLimitStore(env.MAILSWITCH_LIMITER),
       connect: (target) =>
         connect(
           { hostname: target.hostname, port: target.port },
           { secureTransport: target.secureTransport, allowHalfOpen: false },
         ),
     });
   }
   ```

- A batch takes one rate token per message.
- A send above the rate gets `not_sent/rate_limited` with `retryAfterMs`. Put the message back in the campaign queue and run it after that time.
- A provider at its cap gets `not_sent/daily_cap` with `resetAt`. Pause the campaign until that time.
- Keep the old Envelopen Durable Object classes until no running campaign uses them. Then remove them with a `deleted_classes` migration.

## Failure reason renames

Two reasons have new names. Six reasons are new.

| `@envelopen/providers` | mailswitch |
|---|---|
| `validation` | `invalid_message` |
| `server_error` | `provider_error` |
| `auth`, `rate_limited`, `quota`, `credits`, `rejected`, `timeout`, `network` | No change |
| None | `unsupported`, `daily_cap`, `idempotency_conflict`, `stale_pending`, `in_flight`, `store_error` |

A `server_error` was often treated as safe to retry. In mailswitch, a 5xx answer is `unknown/provider_error`. Do not retry an `unknown` result.

Map the stored reasons of old rows when the app reads them:

```ts
import type { FailureReason } from "mailswitch";

const RENAMED: Readonly<Record<string, FailureReason>> = {
  validation: "invalid_message",
  server_error: "provider_error",
};

export function currentReason(stored: string): string {
  return RENAMED[stored] ?? stored;
}
```

The new reasons:

| Reason | Status | Meaning |
|---|---|---|
| `unsupported` | `not_sent` | The provider cannot send this message, for example because of its size. |
| `daily_cap` | `not_sent` | The daily cap of the provider is reached. |
| `idempotency_conflict` | `unknown` | The key was used before with a different message. |
| `stale_pending` | `unknown` | An earlier claim for the key did not finish in time. |
| `in_flight` | `unknown` | Another request holds the key now. |
| `store_error` | `not_sent` | A store call failed before the provider call. |

## List-Unsubscribe

mailswitch has no unsubscribe feature. Set `List-Unsubscribe` as a custom header on each message, as in the batch example above. For one-click unsubscribe (RFC 8058), also set `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

- Every built-in provider supports custom headers.
- The app owns the unsubscribe page and the suppression list.
- A header value must not have a line break. mailswitch refuses the message with `not_sent/invalid_message`.

## Re-encrypt the stored credentials

The credential envelope of `mailswitch/crypto` is not the Envelopen format. Re-encrypt each stored credential once.

Follow these rules:

- Keep the current Envelopen credentials module during the migration. Do not remove it yet.
- Decrypt each row with the Envelopen module, and encrypt it with `mailswitch/crypto`.
- Do this for a connection before its first mailswitch send.
- Remove the old module only after a full pass finds no row in the old format.
- Do not log the plain text, and do not put it in an error.

```ts
import { createKeyRing, decrypt, encrypt } from "mailswitch/crypto";

interface Env {
  DB: D1Database;
  CREDENTIALS_KEY_V1: string;
}
interface ConnectionRow {
  id: string;
  provider: string;
  credentials: string;
}
// The current Envelopen credentials module. Keep it until the migration is complete.
declare function legacyDecrypt(env: Env, row: ConnectionRow): Promise<string>;

const isMailswitchEnvelope = (value: string) => value.startsWith("ms1.");

/** Re-encrypts one row. Returns true when it changed the row. */
export async function migrateConnection(env: Env, row: ConnectionRow): Promise<boolean> {
  if (isMailswitchEnvelope(row.credentials)) return false;
  const ring = createKeyRing({ keys: [{ version: 1, secret: env.CREDENTIALS_KEY_V1 }], current: 1 });
  const scope = ["connection", row.id, row.provider];
  const plaintext = await legacyDecrypt(env, row);
  const envelope = await encrypt(ring, plaintext, scope);
  // Check the new envelope before the old one is replaced.
  if ((await decrypt(ring, envelope, scope)) !== plaintext) {
    throw new Error(`The re-encryption of connection ${row.id} did not round-trip.`);
  }
  // The WHERE clause keeps a concurrent change of the row safe.
  const update = await env.DB.prepare(
    "UPDATE connections SET credentials = ?1 WHERE id = ?2 AND credentials = ?3",
  )
    .bind(envelope, row.id, row.credentials)
    .run();
  return update.meta.changes === 1;
}

/** One full pass. The old module can go when this returns 0 on a later pass. */
export async function migrateAll(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, provider, credentials FROM connections WHERE credentials NOT LIKE 'ms1.%'",
  ).all<ConnectionRow>();
  for (const row of results) await migrateConnection(env, row);
  return results.length;
}
```

The send path must not read a row in the old format with `mailswitch/crypto`. Before each send, call `migrateConnection` for that row, or refuse the send until the pass reaches it.

## Webhooks

Use `handleWebhook` from `mailswitch/webhooks` for every provider. Call `ack()` only after the app handles the events. A handler that does not call `ack()` must answer with a non-2xx status.

### Amazon SES

The topic allowlist is now the `secret` of `handleWebhook`. Give one topic ARN, or several ARNs separated by commas. An empty allowlist refuses every message. mailswitch does not confirm a subscription by itself.

```ts
import { ses, snsConfirmAction } from "mailswitch/ses";
import type { DedupeStore } from "mailswitch/stores/d1";
import { handleWebhook } from "mailswitch/webhooks";

interface Env {
  SES_ALLOWED_TOPIC_ARNS: string;
}
declare const dedupe: DedupeStore;
declare function handleEvents(events: readonly unknown[]): Promise<void>;

const adapter = ses();

export async function onSesWebhook(request: Request, env: Env): Promise<Response> {
  const outcome = await handleWebhook(request, {
    adapter,
    secret: env.SES_ALLOWED_TOPIC_ARNS,
    dedupe,
  });
  if (!outcome.ok) return new Response(null, { status: outcome.status });
  for (const event of outcome.events) {
    const action = snsConfirmAction(event);
    if (action) await fetch(action.subscribeUrl);
  }
  await handleEvents(outcome.events);
  await outcome.ack();
  return new Response(null, { status: 200 });
}
```

See [Amazon SES](../providers/ses.md#the-topic-allowlist) for the allowlist rules.

### Mailgun and Postmark

The Mailgun and Postmark adapters require a dedupe store. The types refuse a call without one, and `handleWebhook` throws a `TypeError` when it is missing. The Mailgun signature does not cover the body, and Postmark Basic auth covers no timestamp. The dedupe store is the replay guard for both.

```ts
import { mailgun } from "mailswitch/mailgun";
import { postmark } from "mailswitch/postmark";
import { D1DedupeStore } from "mailswitch/stores/d1";
import { handleWebhook } from "mailswitch/webhooks";

interface Env {
  DB: D1Database;
  MAILGUN_WEBHOOK_SIGNING_KEY: string;
  POSTMARK_WEBHOOK_SECRET: string;
}

export async function onProviderWebhook(
  request: Request,
  env: Env,
  provider: "mailgun" | "postmark",
): Promise<Response> {
  const dedupe = new D1DedupeStore(env.DB);
  const outcome =
    provider === "mailgun"
      ? await handleWebhook(request, {
          adapter: mailgun(),
          secret: env.MAILGUN_WEBHOOK_SIGNING_KEY,
          dedupe,
        })
      : await handleWebhook(request, {
          adapter: postmark(),
          secret: env.POSTMARK_WEBHOOK_SECRET,
          dedupe,
        });
  if (!outcome.ok) return new Response(null, { status: outcome.status });
  await outcome.ack();
  return new Response(null, { status: 200 });
}
```

Use an atomic dedupe store: D1 in production. Do not use KV.

## Migration order

1. Add mailswitch next to `@envelopen/providers`. Do not remove the old package yet.
2. Deploy the two Durable Object classes and their migration.
3. Run the credential pass, `migrateAll`, until it returns 0.
4. Move the webhook routes to `handleWebhook`, one provider at a time.
5. Move the send path to `createMailer` and `sendBatch`. Map the stored failure reasons.
6. Run one campaign to a test list. Check each result row.
7. Remove `@envelopen/providers`, the old credentials module, and the old Durable Object classes.

## Checklist

- [ ] Each message has its own idempotency key.
- [ ] The mailer has an `idempotency` store for every batch.
- [ ] `MailswitchLimiter` and `MailswitchIdempotency` are exported and bound.
- [ ] Each provider entry has a `rate`, a `dailyCap`, and a `scope` per account.
- [ ] The app maps `validation` and `server_error`, and handles the new reasons.
- [ ] No code retries or re-queues an `unknown` result.
- [ ] Each campaign message has the `List-Unsubscribe` header.
- [ ] A full credential pass finds no row in the old format.
- [ ] The SES route passes the topic allowlist as the `secret`.
- [ ] The Mailgun and Postmark routes pass a D1 dedupe store.
