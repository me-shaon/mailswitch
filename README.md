# mailswitch

Transactional email for Cloudflare Workers. One API sends through Resend or toSend, with a fallback to a second provider. A retry with the same idempotency key never sends the same email twice.

> **Status:** 0.1 pre-release. The package is not on npm yet. The API in this README is the current API of the code in this repository.

## Why mailswitch

Most email libraries assume Node.js. They need TCP sockets, the filesystem, or Node crypto, so they do not run in a Worker. The libraries that do run in Workers stop at the send call. Your app still has to verify webhooks, parse bounces, and decide when a failed send is safe to retry.

mailswitch covers the whole path for an app that runs on Workers:

- **Safe delivery.** Every send result is `sent`, `not_sent`, or `unknown`. A fallback only happens after `not_sent`, so a timeout never turns into a duplicate invoice.
- **Idempotency for every provider.** When a provider supports an idempotency key, mailswitch passes it. When a store is set, mailswitch also claims each key in the store before the first send. This covers providers with no idempotency key.
- **Webhooks built in.** mailswitch checks the provider signature over the raw body, blocks replays with a dedupe store, and turns bounces and complaints into one event type.
- **Workers first.** Zero runtime dependencies. mailswitch uses Web APIs only: `fetch`, Web Crypto, and streams. Each provider is its own import, so your Worker bundles only what it uses.
- **Built for settings screens.** Each provider describes its credential fields. It can check credentials without a send, and it can send a test email. A self-hosted app can let its owner pick a provider in the UI and store the keys encrypted.

## Use cases

- **Self-hosted SaaS on Workers.** Let each deployer choose an email provider, and store the keys encrypted.
- **Invoices, receipts, and reports.** Send PDF attachments with no duplicates, even when a job retries.
- **Auth email.** Send invites, password resets, and sign-in links through the same layer as the rest of your app email.
- **Provider failover.** Fall back to a second provider when the first one did not accept the email.

## Benefits

| Without mailswitch | With mailswitch |
|---|---|
| One hand-written client per provider | One `send()` for every provider |
| A timeout can cause a duplicate email | A send with an unclear result is never retried automatically |
| One webhook format and signature scheme per provider | One verified event type for every provider |
| Settings forms written by hand for each provider | Credential field descriptions drive the form |

## Install

The package is not published yet. After the 0.1 release, install it with:

```sh
npm install mailswitch
```

mailswitch is ESM only. It needs no compatibility flags in Workers.

## Send an email

This example sends an invoice through Resend, with toSend as the fallback. D1 holds the idempotency records and the daily cap counters. Create the tables first with `D1_SCHEMA` (see [the PlainBooks guide](docs/guides/plainbooks.md#d1-schema)).

```ts
import { createMailer } from "mailswitch";
import { resend } from "mailswitch/resend";
import { D1DailyCapStore, D1IdempotencyStore } from "mailswitch/stores/d1";
import { tosend } from "mailswitch/tosend";

declare const env: {
  DB: D1Database;
  RESEND_API_KEY: string;
  TOSEND_API_KEY: string;
};
declare const pdfBytes: Uint8Array;

const mailer = createMailer({
  providers: [
    // The primary. Resend allows 100 emails per day on its free plan.
    { adapter: resend(), credentials: { apiKey: env.RESEND_API_KEY }, dailyCap: 100 },
    // The fallback. It runs only when Resend returns not_sent.
    { adapter: tosend(), credentials: { apiKey: env.TOSEND_API_KEY } },
  ],
  // A stable name for the idempotency keys of this app. Changing it frees every key.
  namespace: "studio-one",
  idempotency: new D1IdempotencyStore(env.DB),
  dailyCaps: new D1DailyCapStore(env.DB),
});

const result = await mailer.send({
  from: { email: "billing@studio.example", name: "Studio One" },
  to: [{ email: "client@example.com" }],
  subject: "Invoice INV-0042",
  html: "<p>Your invoice is attached.</p>",
  attachments: [{ filename: "INV-0042.pdf", content: pdfBytes, contentType: "application/pdf" }],
  idempotencyKey: "invoice:INV-0042:send:1",
});

if (result.status === "sent") {
  console.log("sent through", result.provider, result.providerMessageId);
} else if (result.status === "not_sent") {
  // The email did not go out. A retry later is safe.
  console.log("not sent:", result.reason);
} else {
  // The email may have gone out. Do not retry. Ask a person to check.
  console.log("unknown:", result.reason);
}
```

`createMailer` throws a `TypeError` for invalid options, for example a malformed API key. A provider failure never throws. It comes back as a result.

## Delivery status

Every send returns one of three statuses.

| Status | Meaning | What your app does |
|---|---|---|
| `sent` | The provider accepted the email. | Record the provider message ID. |
| `not_sent` | The email did not go out. | Retry later, or show the reason. A retry cannot send a duplicate. |
| `unknown` | The email may have gone out. | Do not retry. Ask a person to check with the provider. |

**Never retry or fall back after `unknown`.** mailswitch does not do it, and your app must not do it either. A timeout, a network error, and an HTTP 5xx answer are all `unknown`, because the provider may have accepted the email before the failure.

Each failed result has a `reason`, such as `auth`, `rate_limited`, `daily_cap`, or `timeout`. The [delivery-safety guide](docs/guides/delivery-safety.md) has the full table and the idempotency record lifecycle.

## Receive webhooks

`handleWebhook` verifies the signature, removes duplicate events, and returns the events in one shape. Dedupe has two phases. mailswitch claims each event, and your handler calls `ack()` after it handles the events. A handler that does not call `ack()` must answer with a non-2xx status.

```ts
import { D1DedupeStore } from "mailswitch/stores/d1";
import { tosend } from "mailswitch/tosend";
import { handleWebhook } from "mailswitch/webhooks";

interface Env {
  DB: D1Database;
  TOSEND_WEBHOOK_SECRET: string;
}
declare function suppress(env: Env, address: string): Promise<void>;

export async function onWebhook(request: Request, env: Env): Promise<Response> {
  const result = await handleWebhook(request, {
    adapter: tosend(),
    secret: env.TOSEND_WEBHOOK_SECRET,
    dedupe: new D1DedupeStore(env.DB),
  });
  // 401 bad signature, 413 too large, 409 in flight: the provider retries later.
  if (!result.ok) return new Response(null, { status: result.status });
  try {
    for (const event of result.events) {
      if (event.type === "bounced" && event.bounce === "hard" && event.recipient) {
        await suppress(env, event.recipient);
      }
    }
  } catch {
    // Not handled, so no ack(). A non-2xx status makes the provider send it again.
    await result.release();
    return new Response(null, { status: 500 });
  }
  await result.ack();
  return new Response(null, { status: 200 });
}
```

- A request that arrives while another request handles the same event gets `in_flight`, which maps to HTTP 409.
- A replay of an acknowledged event is left out of `events`. The handler answers 200.
- toSend signs no timestamp, so its adapter requires a dedupe store. The types refuse a call without one.
- toSend sends each event once and does not retry. A non-2xx answer to toSend loses that event. Check the toSend logs after an outage. Resend retries a non-2xx answer for about a day.

## Providers in 0.1

| Provider | Import | Tier | Attachments | Native idempotency | Webhook events | Guide |
|---|---|---|---|---|---|---|
| Resend | `mailswitch/resend` | 1 | Yes, up to 40 MB | Yes | Delivered, bounce, complaint | [Resend](docs/providers/resend.md) |
| toSend | `mailswitch/tosend` | 1 | Yes, up to 10 MB | No (store claim) | Bounce, complaint | [toSend](docs/providers/tosend.md) |

A tier 1 provider has send, attachments, credential verify, webhooks where the provider offers them, and a status map with a source for each override.

Release 0.2 adds Postmark, Amazon SES, SMTP, Mailgun, and Cloudflare Email.

To add your own provider, follow [Add a provider](docs/guides/add-a-provider.md). The conformance suite checks your adapter the same way as the built-in ones.

## Settings-screen tools

A self-hosted app can let its owner pick a provider and enter the keys in a form.

- `mailswitch/catalog` exports `catalog` and `getProviderMeta(id)`. Each entry holds the name, tier, capabilities, and credential fields. The catalog imports no adapter code.
- `parseCredentials(meta, input)` checks the form input against the credential fields. Errors name the field and the rule, never the value.
- `adapter.verify(ctx)` checks the credentials with a call that sends no email.
- `sendTestEmail(adapter, ctx, options)` sends one fixed test email.
- `mailswitch/crypto` encrypts the credentials at rest with a key ring (AES-256-GCM). The key ring supports key rotation with `needsReencrypt`.

```ts
import { parseCredentials, type SendContext, sendTestEmail } from "mailswitch";
import { getProviderMeta } from "mailswitch/catalog";
import { createKeyRing, encrypt } from "mailswitch/crypto";
import { resend } from "mailswitch/resend";

declare const env: { CREDENTIALS_KEY_V1: string };
declare const form: Record<string, string>;

const meta = getProviderMeta("resend");
if (!meta) throw new Error("Unknown provider.");

const parsed = parseCredentials(meta, form);
if (!parsed.ok) throw new Error(`Check these fields: ${parsed.errors.map((e) => e.field)}`);

const ctx: SendContext = {
  fetch: (input, init) => fetch(input, init),
  timeoutMs: 15_000,
  credentials: parsed.values,
  now: Date.now(),
};
const adapter = resend();
const check = await adapter.verify(ctx);
if (check.ok) {
  await sendTestEmail(adapter, ctx, { from: "hello@studio.example", to: "owner@studio.example" });
}

// The secret is at least 32 bytes, as base64 text.
const ring = createKeyRing({ keys: [{ version: 1, secret: env.CREDENTIALS_KEY_V1 }], current: 1 });
const stored = await encrypt(ring, JSON.stringify(parsed.values), ["workspace", "42", meta.id]);
```

## Documentation

- [Delivery safety](docs/guides/delivery-safety.md): statuses, idempotency, fallback, and operator steps.
- [PlainBooks integration](docs/guides/plainbooks.md): invoices with PDFs, D1 setup, daily caps, and a job outbox.
- [Resend](docs/providers/resend.md) and [toSend](docs/providers/tosend.md): setup, limits, and webhooks.
- [Add a provider](docs/guides/add-a-provider.md): write and test a new adapter.
- [examples/worker-basic](examples/worker-basic/): a Worker that sends an invoice and receives webhooks.

## Who uses it

mailswitch grows out of the provider layer in [Envelopen](https://github.com/me-shaon/envelopen), a self-hosted email marketing tool on Workers. [PlainBooks](https://github.com/me-shaon/plainbooks), a self-hosted invoicing app on Workers, will use it for invoices, reminders, and auth email.

## License

MIT. See [LICENSE](LICENSE).
