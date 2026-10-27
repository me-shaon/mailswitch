# mailswitch

Transactional email for Cloudflare Workers. One API sends through Resend, toSend, Postmark, Amazon SES, Mailgun, SendGrid, Brevo, MailerSend, Mailjet, SMTP2GO, ZeptoMail, Cloudflare Email, or any SMTP server, with a fallback to a second provider. A retry with the same idempotency key never sends the same email twice.

> **Status:** pre-1.0. The package is on npm as `mailswitch`. A minor release can change the public API. The changelog names each change.

## Why mailswitch

Most email libraries assume Node.js. They need TCP sockets, the filesystem, or Node crypto, so they do not run in a Worker. The libraries that do run in Workers stop at the send call. Your app still has to verify webhooks, parse bounces, and decide when a failed send is safe to retry.

mailswitch covers the whole path for an app that runs on Workers:

- **Safe delivery.** Every send result is `sent`, `not_sent`, or `unknown`. A fallback only happens after `not_sent`, so a timeout never turns into a duplicate invoice.
- **Idempotency for every provider.** When a provider supports an idempotency key, mailswitch passes it. When a store is set, mailswitch also claims each key in the store before the first send. This covers providers with no idempotency key.
- **Webhooks built in.** mailswitch checks the provider signature over the raw body, blocks replays with a dedupe store, and turns bounces and complaints into one event type.
- **Workers first.** Zero runtime dependencies. mailswitch uses Web APIs only: `fetch`, Web Crypto, and streams. Each provider is its own import, so your Worker bundles only what it uses.
- **Batches and limits.** `sendBatch()` sends many fully built messages with one idempotency claim per message. Per-provider rate limits and daily caps keep a campaign inside the plan of each account.
- **Built for settings screens.** Each provider describes its credential fields. It can check credentials without a send, and it can send a test email. A self-hosted app can let its owner pick a provider in the UI and store the keys encrypted.

## Use cases

- **Self-hosted SaaS on Workers.** Let each deployer choose an email provider, and store the keys encrypted.
- **Invoices, receipts, and reports.** Send PDF attachments with no duplicates, even when a job retries.
- **Auth email.** Send invites, password resets, and sign-in links through the same layer as the rest of your app email.
- **Provider failover.** Fall back to a second provider when the first one did not accept the email.
- **Campaign sends.** Send a batch of personalized messages under a rate limit, with List-Unsubscribe as a custom header.

## Benefits

| Without mailswitch | With mailswitch |
|---|---|
| One hand-written client per provider | One `send()` for every provider |
| A timeout can cause a duplicate email | A send with an unclear result is never retried automatically |
| One webhook format and signature scheme per provider | One verified event type for every provider |
| Settings forms written by hand for each provider | Credential field descriptions drive the form |

## Install

The package is not published yet. After the 0.1.0 release, install it with:

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
  // 401 bad signature, 413 too large, 409 in flight. toSend sends each event once with no
  // retries, so a refused event is lost. Check the toSend logs for it.
  if (!result.ok) return new Response(null, { status: result.status });
  try {
    for (const event of result.events) {
      if (event.type === "bounced" && event.bounce === "hard" && event.recipient) {
        await suppress(env, event.recipient);
      }
    }
  } catch {
    // Not handled, so no ack(). release() frees the event for a provider that retries.
    // toSend does not retry, so check its logs for this event.
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
- Each provider guide gives the webhook secret and the replay rules of that provider. Postmark, Mailgun, toSend, SendGrid, Brevo, MailerSend, Mailjet, and SMTP2GO need a dedupe store. Amazon SES takes its topic allowlist as the `secret`.

## Providers

| Provider | Import | Tier | Max message size | Native idempotency | Batch | Webhooks | Guide |
|---|---|---|---|---|---|---|---|
| Resend | `mailswitch/resend` | 1 | 40 MB | Yes | 50, no attachments | Svix signature | [Resend](docs/providers/resend.md) |
| toSend | `mailswitch/tosend` | 1 | 10 MB | No (store claim) | 50 | HMAC, dedupe store required | [toSend](docs/providers/tosend.md) |
| Postmark | `mailswitch/postmark` | 1 | 10 MB | No (store claim) | 500 | Basic auth, dedupe store required | [Postmark](docs/providers/postmark.md) |
| Amazon SES | `mailswitch/ses` | 1 | 40 MB | No (store claim) | One request per message | SNS signature and topic allowlist | [Amazon SES](docs/providers/ses.md) |
| Mailgun | `mailswitch/mailgun` | 1 | 25 MB | No (store claim) | One request per message | HMAC, dedupe store required | [Mailgun](docs/providers/mailgun.md) |
| SendGrid | `mailswitch/sendgrid` | 1 | 20 MB | No (store claim) | One request per message | ECDSA signature, dedupe store required | [SendGrid](docs/providers/sendgrid.md) |
| Brevo (HTTP API) | `mailswitch/brevo` | 1 | 20 MB | Yes, for 30 minutes (also store claim) | One request per message | Bearer token, dedupe store required | [Brevo](docs/providers/brevo.md) |
| MailerSend | `mailswitch/mailersend` | 1 | 25 MB | No (store claim) | One request per message | HMAC, dedupe store required | [MailerSend](docs/providers/mailersend.md) |
| Mailjet | `mailswitch/mailjet` | 1 | 15 MB per request | No (store claim) | 50 | Basic auth, dedupe store required | [Mailjet](docs/providers/mailjet.md) |
| SMTP2GO | `mailswitch/smtp2go` | 1 | 50 MB | No (store claim) | One request per message | Basic or Bearer token, dedupe store required | [SMTP2GO](docs/providers/smtp2go.md) |
| ZeptoMail | `mailswitch/zeptomail` | 2 | 15 MB | No (store claim) | One request per message | None | [ZeptoMail](docs/providers/zeptomail.md) |
| Cloudflare Email (REST API) | `mailswitch/cloudflare` | 1 | 5 MiB | No (store claim) | 25, 5 at a time | None | [Cloudflare Email](docs/providers/cloudflare.md) |
| Cloudflare Email (Workers binding) | `mailswitch/cloudflare` | 1 | 5 MiB | No (store claim) | One call per message | None | [Cloudflare Email](docs/providers/cloudflare.md) |
| SMTP | `mailswitch/smtp` | 1 | The server `SIZE` | No (store claim) | 50 on one connection | Brevo, from `mailswitch/smtp/brevo` | [SMTP](docs/providers/smtp.md) |

Every provider supports attachments, cc, bcc, reply-to, and custom headers. Brevo has no inline images: it refuses an attachment with a `contentId`. MailerSend accepts custom headers only on its Professional plan and above.

A tier 1 provider has send, attachments, credential verify, webhooks where the provider offers them, and a status map with a source for each override. A tier 2 provider has send, attachments, and verify, and every 5xx is `unknown`.

The SMTP adapter has presets. A preset fixes the host, the port, and the encryption, and sets a default daily cap.

| Preset | Host | Default daily cap |
|---|---|---|
| `gmail` | `smtp.gmail.com` | 500 |
| `google-workspace` | `smtp.gmail.com` | 2,000 |
| `brevo` | `smtp-relay.brevo.com` | 300 |
| `mailpit` | Local test server | None |
| `mailcrab` | Local test server | None |
| `custom` | You give it | None |

The SMTP adapter opens no sockets itself. Your Worker passes the `connect` function of `cloudflare:sockets` to `createMailer`. See [the SMTP guide](docs/providers/smtp.md).

To add your own provider, follow [Add a provider](docs/guides/add-a-provider.md). The conformance suite checks your adapter the same way as the built-in ones.

## Send a batch

`sendBatch()` takes fully built messages and returns one result per message, in input order. mailswitch renders no templates. Build each message, with its own subject and body, before the call.

```ts
import { createMailer } from "mailswitch";
import { postmark } from "mailswitch/postmark";
import { D1IdempotencyStore } from "mailswitch/stores/d1";

declare const env: { DB: D1Database; POSTMARK_SERVER_TOKEN: string };
declare const members: { id: string; email: string; name: string }[];

const mailer = createMailer({
  providers: [{ adapter: postmark(), credentials: { serverToken: env.POSTMARK_SERVER_TOKEN } }],
  namespace: "studio-one",
  idempotency: new D1IdempotencyStore(env.DB),
});

const results = await mailer.sendBatch(
  members.map((member) => ({
    from: { email: "news@studio.example", name: "Studio One" },
    to: [{ email: member.email, name: member.name }],
    subject: "Our October news",
    html: `<p>Hello ${member.name}, here is our news.</p>`,
    headers: { "List-Unsubscribe": `<https://studio.example/unsubscribe/${member.id}>` },
    // One key per message. A batch request sends no native key.
    idempotencyKey: `newsletter:2026-10:${member.id}`,
  })),
);
const unknown = results.filter((result) => result.status === "unknown").length;
```

- The batch uses the batch endpoint of the primary when it has one. The other messages go through single sends.
- A batch request carries no native idempotency key. Only the store claim protects each message, so set an `idempotency` store.
- After the batch, only the `not_sent` messages go to the fallbacks. An `unknown` message never does.

## Rate limits and Durable Object stores

A provider entry can have a `rate` of sends per second. A send above the rate gets `not_sent/rate_limited` with `retryAfterMs`, and the fallback runs. The rate needs a `rateLimits` store.

In production, use the Durable Object stores. Every isolate then shares one token bucket and one daily counter per provider.

```ts
import { createMailer } from "mailswitch";
import { resend } from "mailswitch/resend";
import {
  durableObjectDailyCapStore,
  durableObjectIdempotencyStore,
  durableObjectRateLimitStore,
} from "mailswitch/stores/durable-object";

// Export the two classes from the Worker entry, so that the bindings find them.
export { MailswitchIdempotency, MailswitchLimiter } from "mailswitch/stores/durable-object";

declare const env: {
  MAILSWITCH_LIMITER: DurableObjectNamespace;
  MAILSWITCH_IDEMPOTENCY: DurableObjectNamespace;
  RESEND_API_KEY: string;
};

const mailer = createMailer({
  providers: [
    {
      adapter: resend(),
      credentials: { apiKey: env.RESEND_API_KEY },
      rate: { perSecond: 2 },
      dailyCap: 3000,
    },
  ],
  namespace: "studio-one",
  idempotency: durableObjectIdempotencyStore(env.MAILSWITCH_IDEMPOTENCY),
  dailyCaps: durableObjectDailyCapStore(env.MAILSWITCH_LIMITER),
  rateLimits: durableObjectRateLimitStore(env.MAILSWITCH_LIMITER),
});
```

Bind both classes in `wrangler.jsonc`:

```jsonc
"durable_objects": { "bindings": [
  { "name": "MAILSWITCH_LIMITER", "class_name": "MailswitchLimiter" },
  { "name": "MAILSWITCH_IDEMPOTENCY", "class_name": "MailswitchIdempotency" }
] },
"migrations": [
  { "tag": "mailswitch-v1", "new_sqlite_classes": ["MailswitchLimiter", "MailswitchIdempotency"] }
]
```

| Store | Memory (tests) | D1 | Durable Object |
|---|---|---|---|
| Idempotency | `MemoryIdempotencyStore` | `D1IdempotencyStore` | `durableObjectIdempotencyStore` |
| Daily caps | `MemoryDailyCapStore` | `D1DailyCapStore` | `durableObjectDailyCapStore` |
| Rate limits | `MemoryRateLimitStore` | None | `durableObjectRateLimitStore` |
| Webhook dedupe | `MemoryDedupeStore` | `D1DedupeStore` | None |

## Settings-screen tools

A self-hosted app can let its owner pick a provider and enter the keys in a form.

- `mailswitch/catalog` exports `catalog` and `getProviderMeta(id)`. Each entry holds the name, tier, capabilities, and credential fields. The catalog imports no adapter code.
- `parseCredentials(meta, input)` checks the form input against the credential fields. Errors name the field and the rule, never the value.
- `createSendContext({ credentials })` builds the context of a direct adapter call. It uses the global `fetch`, a 15-second timeout, and the current time, unless you give others. Give `connect` for SMTP.
- `adapter.verify(ctx)` checks the credentials with a call that sends no email.
- `sendTestEmail(adapter, ctx, options)` sends one fixed test email.
- `mailswitch/crypto` encrypts the credentials at rest with a key ring (AES-256-GCM). The key ring supports key rotation with `needsReencrypt`.

```ts
import { createSendContext, parseCredentials, sendTestEmail } from "mailswitch";
import { getProviderMeta } from "mailswitch/catalog";
import { createKeyRing, encrypt } from "mailswitch/crypto";
import { resend } from "mailswitch/resend";

declare const env: { CREDENTIALS_KEY_V1: string };
declare const form: Record<string, string>;

const meta = getProviderMeta("resend");
if (!meta) throw new Error("Unknown provider.");

const parsed = parseCredentials(meta, form);
if (!parsed.ok) throw new Error(`Check these fields: ${parsed.errors.map((e) => e.field)}`);

const ctx = createSendContext({ credentials: parsed.values });
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

Guides:

- [Delivery safety](docs/guides/delivery-safety.md): statuses, idempotency, fallback, and operator steps.
- [PlainBooks integration](docs/guides/plainbooks.md): invoices with PDFs, D1 setup, daily caps, a job outbox, and a settings screen.
- [Envelopen migration](docs/guides/envelopen.md): move from `@envelopen/providers` to mailswitch.
- [Add a provider](docs/guides/add-a-provider.md): write and test a new adapter.
- [Releasing](docs/guides/releasing.md): the pre-release checks and the publish flow.

Providers:

- [Resend](docs/providers/resend.md)
- [toSend](docs/providers/tosend.md)
- [Postmark](docs/providers/postmark.md)
- [Amazon SES](docs/providers/ses.md)
- [Mailgun](docs/providers/mailgun.md)
- [Cloudflare Email](docs/providers/cloudflare.md)
- [SMTP](docs/providers/smtp.md), with the presets and Brevo webhooks

Example:

- [examples/worker-basic](examples/worker-basic/): a Worker that sends an invoice and receives webhooks.

## Who uses it

mailswitch grows out of the provider layer in [Envelopen](https://github.com/me-shaon/envelopen), a self-hosted email marketing tool on Workers. [PlainBooks](https://github.com/me-shaon/plainbooks), a self-hosted invoicing app on Workers, will use it for invoices, reminders, and auth email.

## License

MIT. See [LICENSE](LICENSE).
