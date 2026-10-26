# mailswitch

Transactional email for Cloudflare Workers. One API sends through Resend, toSend, Postmark, Amazon SES, Mailgun, Cloudflare Email, or any SMTP server. It never sends the same email twice.

> **Status:** in planning. The API below is the target design, not a published package yet.

## Why mailswitch

Most email libraries assume Node.js. They need TCP sockets, the filesystem, or Node crypto, so they do not run in a Worker. The libraries that do run in Workers stop at the send call. Your app still has to verify webhooks, parse bounces, and decide when a failed send is safe to retry.

mailswitch covers the whole path for an app that runs on Workers:

- **Safe delivery.** Every send result says `sent`, `not_sent`, or `unknown`. A retry or a fallback only happens after `not_sent`, so a timeout never turns into a duplicate invoice.
- **Idempotency for every provider.** When a provider supports an idempotency key, mailswitch passes it. When it does not, a small store (D1 or a Durable Object) claims each key before the send.
- **Webhooks built in.** mailswitch checks each provider's signature, blocks replays, and turns bounces and complaints into one event type.
- **Workers first.** Zero runtime dependencies. SMTP runs over `cloudflare:sockets`. Amazon SES signing uses Web Crypto. Each provider is its own import, so your Worker bundles only what it uses.
- **Built for settings screens.** Each provider describes its credential fields, can check credentials without sending, and can send a test email. A self-hosted app can let its owner pick a provider in the UI.

## Use cases

- **Self-hosted SaaS on Workers.** Let each deployer choose their own email provider, and store the keys encrypted.
- **Invoices, receipts, and reports.** Send PDF attachments with a guarantee of no duplicates, even when a job retries.
- **Auth email.** Send invites, password resets, and sign-in links through the same layer as the rest of your app email.
- **Email marketing tools.** Send batches with per-provider rate limits and daily caps, and track bounces to keep your list clean.
- **Provider migration or failover.** Switch providers through config, or fall back to a second provider when the first one did not accept the email.

## Benefits

| Without mailswitch | With mailswitch |
|---|---|
| One hand-written client per provider | One `send()` for every provider |
| A timeout can cause a duplicate email | A send with an unclear result is never retried automatically |
| One webhook format and signature scheme per provider | One verified event type for every provider |
| Node-only libraries, or a missing SMTP option on Workers | Runs in Workers, with SMTP over sockets |
| Settings forms written by hand for each provider | Credential field descriptions drive the form |

## Target API

```ts
import { createMailer } from "mailswitch";
import { tosend } from "mailswitch/tosend";
import { resend } from "mailswitch/resend";
import { d1IdempotencyStore } from "mailswitch/stores/d1";

const mailer = createMailer({
  provider: tosend({ apiKey: env.TOSEND_API_KEY }),
  fallback: resend({ apiKey: env.RESEND_API_KEY }),
  idempotency: d1IdempotencyStore(env.DB),
});

const result = await mailer.send({
  from: { email: "billing@studio.example", name: "Studio One" },
  to: [{ email: "client@example.com" }],
  subject: "Invoice INV-0042",
  html: "<p>Your invoice is attached.</p>",
  attachments: [{ filename: "INV-0042.pdf", content: pdfBytes, contentType: "application/pdf" }],
  idempotencyKey: "invoice:INV-0042:send:1",
});

if (result.status === "unknown") {
  // The provider may have sent it. Do not retry. Ask a person to check.
}
```

```ts
import { handleWebhook } from "mailswitch/webhooks";

const events = await handleWebhook(request, {
  provider: "tosend",
  secret: env.TOSEND_WEBHOOK_SECRET,
  dedupe: d1EventStore(env.DB),
});
for (const event of events) {
  if (event.type === "bounced" && event.bounce === "hard") await suppress(event.recipient);
}
```

## Providers

| Provider | Send | Attachments | Native idempotency | Webhooks |
|---|---|---|---|---|
| Resend | Planned | Planned | Yes | Bounce, complaint, delivery |
| toSend | Planned | Planned | No (store-based) | Bounce, complaint |
| Postmark | Planned | Planned | No (store-based) | Bounce, complaint, delivery |
| Amazon SES | Planned | Planned | No (store-based) | Bounce, complaint, delivery (SNS) |
| Mailgun | Planned | Planned | No (store-based) | Bounce, complaint, delivery |
| SMTP (Gmail, Google Workspace, Brevo presets) | Planned | Planned | No (store-based) | Brevo only |
| Cloudflare Email | Planned | Planned | No (store-based) | None |

You can add your own provider with `defineProvider()`. The conformance test kit checks it the same way as the built-in ones.

## Who uses it

mailswitch grows out of the provider layer in [Envelopen](https://github.com/me-shaon/envelopen), a self-hosted email marketing tool on Workers. [PlainBooks](https://github.com/me-shaon/plainbooks), a self-hosted invoicing app on Workers, will use it for invoices, reminders, and auth email.

## License

MIT
