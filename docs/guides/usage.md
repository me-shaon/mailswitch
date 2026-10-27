# Usage guide

[Back to the README](../../README.md)

Working examples for fallback, persistent stores, webhooks, batches, and provider settings.

- [Send an email](#send-an-email)
- [Receive webhooks](#receive-webhooks)
- [Send a batch](#send-a-batch)
- [Rate limits and Durable Object stores](#rate-limits-and-durable-object-stores)
- [Settings-screen tools](#settings-screen-tools)

## Send an email

This example sends an invoice through Resend, with toSend as the fallback. D1 holds the idempotency records and the daily cap counters. Create the tables first with `D1_SCHEMA` (see [the PlainBooks guide](plainbooks.md#d1-schema)).

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
    // The primary, with an app-defined daily cap.
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
- A secret that is too short or has the wrong form gets `invalid_secret`, which maps to HTTP 500. The provider retries, so fix the secret and the events arrive.
- A replay of an acknowledged event is left out of `events`. The handler answers 200.
- toSend signs no timestamp, so its adapter requires a dedupe store. The types refuse a call without one.
- toSend sends each event once and does not retry. A non-2xx answer to toSend loses that event. Check the toSend logs after an outage. Resend retries a non-2xx answer for about a day.
- Each provider guide gives the webhook secret and the replay rules of that provider. Postmark, Mailgun, toSend, SendGrid, Brevo, MailerSend, Mailjet, and SMTP2GO need a dedupe store. Amazon SES takes its topic allowlist as the `secret`.
- To test your webhook route with signed samples, see the [testing guide](testing.md).


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
- A provider with webhooks has `webhookSecret` in its meta. It gives the label, the hint, and the source of the webhook secret input. The source is `"provider"` when the owner copies the value from the provider. It is `"generated"` when your app makes the value with the generate helper of the adapter.
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

