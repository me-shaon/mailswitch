# Use mailswitch in an invoicing app

Last checked: 2026-10-26

This guide shows how a Workers invoicing app, such as PlainBooks, sends invoices and reminders with mailswitch. It covers single sends with PDF attachments, the D1 schema, daily caps, a job outbox, and bounce handling.

Read [Delivery safety](delivery-safety.md) first. This guide uses its terms.

## Contents

1. [The setup](#the-setup)
2. [D1 schema](#d1-schema)
3. [Create the mailer](#create-the-mailer)
4. [Send an invoice with a PDF](#send-an-invoice-with-a-pdf)
5. [Daily caps](#daily-caps)
6. [A job outbox](#a-job-outbox)
7. [Bounces and suppression](#bounces-and-suppression)
8. [Checklist](#checklist)

## The setup

| Part | Choice |
|---|---|
| Primary provider | Resend. It has native idempotency. |
| Fallback provider | toSend. It runs only after Resend returns `not_sent`. |
| Idempotency store | `D1IdempotencyStore` |
| Daily cap store | `D1DailyCapStore` |
| Webhook dedupe store | `D1DedupeStore` |
| Jobs | One row per email in an `email_jobs` table of the app |

One D1 database holds the tables of the app and the tables of mailswitch.

## D1 schema

`mailswitch/stores/d1` exports the schema as `D1_SCHEMA`. It creates three tables:

| Table | Holds |
|---|---|
| `mailswitch_idempotency` | One record per idempotency key |
| `mailswitch_daily_cap` | The cap counters, in 5-minute buckets |
| `mailswitch_webhook_dedupe` | One row per webhook event key |

Put the schema in a D1 migration:

1. Create a migration file:

   ```sh
   npx wrangler d1 migrations create plainbooks add_mailswitch_tables
   ```

2. Copy the text of `D1_SCHEMA` into the new file. Each statement uses `IF NOT EXISTS`.
3. Apply the migration:

   ```sh
   npx wrangler d1 migrations apply plainbooks
   ```

For tests and local tools, `applyD1Schema(db)` runs the same statements in one batch:

```ts
import { applyD1Schema } from "mailswitch/stores/d1";

declare const env: { DB: D1Database };

await applyD1Schema(env.DB);
```

When a later mailswitch version changes the schema, its release notes give the migration.

## Create the mailer

Create the mailer once per request. `createMailer` is cheap. It checks the credentials and throws a `TypeError` for a bad key, so a broken setting fails before any send.

```ts
import { createMailer, type Mailer } from "mailswitch";
import { resend } from "mailswitch/resend";
import { D1DailyCapStore, D1IdempotencyStore } from "mailswitch/stores/d1";
import { tosend } from "mailswitch/tosend";

export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  TOSEND_API_KEY: string;
}

export function plainbooksMailer(env: Env): Mailer {
  return createMailer({
    providers: [
      { adapter: resend(), credentials: { apiKey: env.RESEND_API_KEY }, dailyCap: 100 },
      { adapter: tosend(), credentials: { apiKey: env.TOSEND_API_KEY }, dailyCap: 1000 },
    ],
    namespace: "plainbooks",
    idempotency: new D1IdempotencyStore(env.DB),
    dailyCaps: new D1DailyCapStore(env.DB),
    logger: { warn: (message, data) => console.warn(message, data) },
  });
}
```

Keep the namespace `"plainbooks"` for the life of the app. Changing it frees every key.

When the owner picks the providers in a settings screen, build the `providers` list from the stored settings. Decrypt the credentials with `mailswitch/crypto`, and check them with `parseCredentials` before you save them.

## Send an invoice with a PDF

Use one key per invoice email. Add a send number, so a corrected invoice gets a new key:

```
invoice:<invoice id>:send:<n>
reminder:<invoice id>:<reminder number>
```

The PDF bytes must be the same on every retry for one key. Otherwise the retry gets `unknown/idempotency_conflict`. Generate the PDF once, store it in R2, and attach the stored bytes. See [deterministic message bytes](delivery-safety.md#deterministic-message-bytes).

```ts
import type { Mailer, SendResult } from "mailswitch";

interface Invoice {
  id: string;
  number: string;
  clientEmail: string;
  clientName: string;
  pdfKey: string;
}

declare const env: { INVOICES: R2Bucket };
declare const mailer: Mailer;

export async function sendInvoice(invoice: Invoice, sendNumber: number): Promise<SendResult> {
  const pdf = await env.INVOICES.get(invoice.pdfKey);
  if (!pdf) throw new Error(`The PDF of invoice ${invoice.number} is missing.`);
  return mailer.send({
    from: { email: "billing@studio.example", name: "Studio One" },
    to: [{ email: invoice.clientEmail, name: invoice.clientName }],
    subject: `Invoice ${invoice.number}`,
    text: `Hello ${invoice.clientName}, your invoice ${invoice.number} is attached.`,
    attachments: [
      {
        filename: `${invoice.number}.pdf`,
        content: new Uint8Array(await pdf.arrayBuffer()),
        contentType: "application/pdf",
      },
    ],
    idempotencyKey: `invoice:${invoice.id}:send:${sendNumber}`,
  });
}
```

Resend accepts up to 40 MB per email and toSend up to 10 MB, after base64 encoding. A larger invoice gets `not_sent/unsupported` from toSend.

## Daily caps

A daily cap limits the sends of one provider in a rolling 24 hours. Set `dailyCap` on each provider entry and set the `dailyCaps` store.

- The cap counts each attempt. A `not_sent` result gives the unit back.
- A provider at its cap returns `not_sent/daily_cap`, and the fallback runs.
- When every provider is at its cap, the result is `not_sent/daily_cap` with `resetAt`. Schedule the job for that time.
- The counter name is the provider ID. When two entries use the same provider with two accounts, give each a `scope`, such as `"resend-billing"`.
- A provider answer with the reason `quota`, such as the Resend daily quota, fills the counter. The provider is then skipped until the window has room.

Set the cap from the plan of each account. The Resend Free plan allows 100 emails per day.

## A job outbox

Do not send email inside the request that creates the invoice. Write a job row in the same D1 batch as the invoice change, and send from a queue consumer or a scheduled handler. The job then survives a crash, and the request stays fast.

### The jobs table

```sql
CREATE TABLE email_jobs (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  send_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'failed', 'needs_review')),
  run_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  provider_message_id TEXT,
  updated_at INTEGER NOT NULL
);
```

### Job states

| Send result | New job state | What happens next |
|---|---|---|
| `sent` | `sent` | Store the provider message ID. |
| `not_sent` with a reason that a retry can fix: `rate_limited`, `daily_cap`, `quota`, `credits` | `queued` | Run again at `resetAt`, after `retryAfterMs`, or after a backoff. |
| `not_sent` with any other reason, such as `auth`, `rejected`, or `invalid_message` | `failed` | Show the reason to the owner. A retry does not help until the owner fixes the cause. |
| `unknown` | `needs_review` | **Never re-queue it.** A person checks the provider logs. |

A job in `needs_review` needs a person. Show it in the app with the provider, the time, and the reason. The person checks the provider dashboard:

- If the email went out, the person marks the job as `sent`.
- If the email did not go out, the person releases the key (see [Release an unknown key](delivery-safety.md#release-an-unknown-key)) and queues the job again.

### The worker loop

```ts
import type { SendResult } from "mailswitch";

interface Job {
  id: string;
  invoice_id: string;
  send_number: number;
  tries: number;
}

declare const env: { DB: D1Database };
declare function sendInvoiceJob(job: Job): Promise<SendResult>;

const RETRYABLE = new Set(["rate_limited", "daily_cap", "quota", "credits"]);
const MAX_TRIES = 8;

async function setState(job: Job, state: string, fields: Record<string, unknown> = {}) {
  await env.DB.prepare(
    `UPDATE email_jobs SET state = ?2, reason = ?3, provider_message_id = ?4, run_at = ?5,
       tries = ?6, updated_at = ?7 WHERE id = ?1`,
  )
    .bind(
      job.id,
      state,
      fields.reason ?? null,
      fields.providerMessageId ?? null,
      fields.runAt ?? 0,
      job.tries + 1,
      Date.now(),
    )
    .run();
}

export async function runJob(job: Job): Promise<void> {
  // Take the job. Only one worker can move it from queued to sending.
  const taken = await env.DB.prepare(
    "UPDATE email_jobs SET state = 'sending', updated_at = ?2 WHERE id = ?1 AND state = 'queued'",
  )
    .bind(job.id, Date.now())
    .run();
  if (taken.meta.changes !== 1) return;

  const result = await sendInvoiceJob(job);
  if (result.status === "sent") {
    await setState(job, "sent", { providerMessageId: result.providerMessageId });
  } else if (result.status === "unknown") {
    // The email may have gone out. A person decides. Never re-queue.
    await setState(job, "needs_review", { reason: result.reason });
  } else if (RETRYABLE.has(result.reason) && job.tries + 1 < MAX_TRIES) {
    const wait = result.resetAt
      ? result.resetAt - Date.now()
      : (result.retryAfterMs ?? 60_000 * 2 ** job.tries);
    await setState(job, "queued", { reason: result.reason, runAt: Date.now() + wait });
  } else {
    await setState(job, "failed", { reason: result.reason });
  }
}
```

### A worker that stops in the middle

A Worker can stop after it takes a job and before it writes the result. The job then stays in `sending`. The idempotency store makes a rerun safe:

1. Find jobs in `sending` with `updated_at` older than the pending timeout (10 minutes by default).
2. Move them back to `queued`.
3. The next run sends with the same key. The store answers for the earlier attempt:
   - The earlier send finished as `sent`: the rerun gets the stored `sent` result, and no email goes out.
   - The earlier send finished as `unknown`, or its claim went stale: the rerun gets `unknown`, and the job goes to `needs_review`.
   - The earlier send finished as `not_sent`, or never started: the rerun sends the email.

Do not use a Queues retry for `unknown`. In a queue consumer, call `message.ack()` for every result, and write the job state yourself. Use `message.retry()` only for the retryable `not_sent` reasons.

## Bounces and suppression

mailswitch turns provider webhooks into normalized events. It does not keep a suppression list. The app owns that list.

1. Add a `suppressed_addresses` table with the address, the reason, and the time.
2. In the webhook route, add the recipient of each hard bounce and each complaint to the table. Use the handler from the [README](../../README.md#receive-webhooks).
3. Before each send, check the recipients against the table. Do not send to a suppressed address. Mark the job as `failed` with a clear reason.
4. Let the owner remove an address from the list, for example after a client fixes their mailbox.

```ts
import type { NormalizedEvent } from "mailswitch";

declare const env: { DB: D1Database };

export async function suppressFromEvent(event: NormalizedEvent): Promise<void> {
  const hard = event.type === "bounced" && event.bounce === "hard";
  if (!(hard || event.type === "complained") || !event.recipient) return;
  await env.DB.prepare(
    "INSERT INTO suppressed_addresses (address, reason, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (address) DO NOTHING",
  )
    .bind(event.recipient.toLowerCase(), event.type, Date.now())
    .run();
}
```

Notes:

- Resend sets `recipient` only when the email had one `to` address. Send each invoice to one address in `to`, and put other people in `cc`.
- toSend does not retry webhooks. After an outage, check the toSend logs for missed bounces.
- A soft bounce is temporary. Do not suppress the address for one soft bounce.
- Call `ack()` only after the suppression rows are written. If the write fails, answer non-2xx without `ack()`.

## Checklist

- [ ] The D1 migration has the text of `D1_SCHEMA`.
- [ ] The mailer has `namespace`, `idempotency`, and `dailyCaps`.
- [ ] Each provider entry has a `dailyCap` that matches its plan.
- [ ] Each invoice email has a key with a send number.
- [ ] The PDF for one key has the same bytes on every retry.
- [ ] The job loop never re-queues an `unknown` result.
- [ ] The app shows `needs_review` jobs to a person.
- [ ] A scheduled handler calls `purgeExpired` on the idempotency and dedupe stores.
- [ ] The webhook routes write the suppression list, and the send path checks it.
