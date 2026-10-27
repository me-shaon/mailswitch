# Resend

Last checked: 2026-10-26

| Item | Value |
|---|---|
| Import | `mailswitch/resend` |
| Adapter | `resend(options?)` |
| Meta | `resendMeta` (also in `mailswitch/catalog` as `resend`) |
| Tier | 1 |
| Native idempotency | Yes |
| Webhooks | Yes. Svix signature with a signed timestamp. |

## Setup

1. Create a Resend account at https://resend.com, or sign in.
2. Go to **Domains** and add your sending domain.
3. Add the DNS records that Resend shows: DKIM, SPF on the `send` subdomain, and MX for bounces.
4. Wait until Resend shows the domain as verified.
5. Go to **API Keys** and create a key. A **Sending access** key is enough to send. A **Full access** key can also list domains.
6. Copy the API key. It starts with `re_`.
7. Store the key as a Worker secret, for example `RESEND_API_KEY`.

## Credentials

| Field | Label | Secret | Required | Rule |
|---|---|---|---|---|
| `apiKey` | API key | Yes | Yes | Matches `^re_[A-Za-z0-9_]+$` |

`createMailer` checks the credentials with `parseCredentials` and throws a `TypeError` for a key that does not match.

```ts
import { createMailer } from "mailswitch";
import { resend } from "mailswitch/resend";

declare const env: { RESEND_API_KEY: string };

const mailer = createMailer({
  providers: [{ adapter: resend(), credentials: { apiKey: env.RESEND_API_KEY } }],
});
```

`resend()` takes two optional options:

- `apiKey`: the key, for code that calls the adapter directly. A key in the credentials takes precedence.
- `baseUrl`: the API origin. It defaults to `https://api.resend.com`. Tests and proxies change it. It must be an https URL. Plain http works only for a loopback host, for tests.

### Verify

`adapter.verify(ctx)` calls `GET /domains`. This call sends no email.

- A Full access key gets `{ ok: true }`.
- A Sending access key gets HTTP 401 with the error name `restricted_api_key`. That key can send, so `verify` also returns `{ ok: true }`.
- Any other failure returns `ok: false` with a status and a reason, as a send would.

## Capabilities and limits

| Capability | Value |
|---|---|
| Attachments | Yes |
| Largest message | 40 MB after base64 encoding, attachments included |
| Recipients | At most 50 across `to`, `cc`, and `bcc` |
| Cc, Bcc, Reply-To | Yes |
| Custom headers | Yes, sent unchanged |
| Batch size | 50 emails per `POST /emails/batch` request |
| Attachments in a batch | No. `sendBatch` sends a message with attachments through `POST /emails`. |

mailswitch refuses a message that breaks a limit before any network call. The result is `not_sent` with the reason `unsupported`, so the fallback provider can try the message.

Resend limits that mailswitch does not enforce:

| Limit | Value | What to do |
|---|---|---|
| Rate limit | 10 requests per second per team, shared by all keys | A 429 gives `not_sent/rate_limited` with `retryAfterMs`. |
| Daily quota (Free plan) | 100 emails per UTC day | Set `dailyCap: 100` on the provider entry. A `daily_quota_exceeded` answer gives `not_sent/quota` and fills the daily cap counter. |
| Monthly quota | Set by your plan | A `monthly_quota_exceeded` answer gives `not_sent/quota`. |

## Status mapping

The adapter uses the default table of the classifier (see [Delivery safety](../guides/delivery-safety.md#status-table)) with one override:

| HTTP status | Status | Reason | Source |
|---|---|---|---|
| 409 | `unknown` | `idempotency_conflict` | [Idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys) |

Resend answers 409 when a request with the same key is in progress, or when the key was used with a different payload. The earlier request may have sent the email, so the result is `unknown`.

For a `not_sent` result, the adapter reads the Resend error name to refine the reason. The status never changes.

| Resend error name | Reason |
|---|---|
| `daily_quota_exceeded`, `monthly_quota_exceeded` | `quota` |
| `rate_limit_exceeded` | `rate_limited` |
| A name that ends in `_api_key` | `auth` |
| `validation_error` with the text "API key is invalid" | `auth` |

The result message never copies the response body.

## Idempotency

Resend accepts an `Idempotency-Key` header and keeps each key for 24 hours.

- `send` passes the `idempotencyKey` of the message as the header.
- A key of printable ASCII with at most 256 characters goes out as it is. Any other key goes out as the SHA-256 hex of its UTF-8 bytes. `resendIdempotencyKey(key)` returns the header value.
- `POST /emails/batch` carries no key, because the key would cover the whole request. In a batch, only the store claim protects a keyed message.
- When the mailer has an idempotency store, mailswitch also claims the key in the store. This protects the fallback provider and covers retries after the 24 hours of Resend.

## Webhooks

Resend signs webhooks with Svix. The signature covers the event ID, a timestamp, and the raw body.

### Set up the endpoint

1. In the Resend dashboard, open **Webhooks** and select **Add Webhook**.
2. Enter the URL of your webhook route, for example `https://app.example.com/webhooks/resend`.
3. Select the events `email.delivered`, `email.bounced`, and `email.complained`.
4. Save the webhook. Copy its signing secret. It starts with `whsec_`.
5. Store the secret as a Worker secret, for example `RESEND_WEBHOOK_SECRET`.

### Handle the events

```ts
import { resend } from "mailswitch/resend";
import { D1DedupeStore } from "mailswitch/stores/d1";
import { handleWebhook } from "mailswitch/webhooks";

declare const env: { DB: D1Database; RESEND_WEBHOOK_SECRET: string };
declare const request: Request;

const result = await handleWebhook(request, {
  adapter: resend(),
  secret: env.RESEND_WEBHOOK_SECRET,
  dedupe: new D1DedupeStore(env.DB),
});
```

Use the full handler from the [README](../../README.md#receive-webhooks): answer with `result.status` when `ok` is false, call `ack()` after you handle the events, and answer non-2xx without `ack()`.

| Item | Value |
|---|---|
| Signature headers | `svix-id`, `svix-timestamp`, `svix-signature` (the `webhook-` prefix also works) |
| Secret | The `whsec_` secret. A secret that is not valid base64 is a setup error. The webhook check refuses each request as `invalid_secret` (HTTP 500). |
| Signed timestamp | Yes. A timestamp more than 5 minutes away from now is refused as `stale` (HTTP 401). |
| Secret rotation | The header can hold more than one `v1,` signature. One valid signature is enough. |
| Event key | The `svix-id` header. It stays the same across retries of one delivery. |
| Dedupe store | Optional in the types. Use one: Resend retries, so the same event can arrive twice. |
| Dedupe TTL | 7 days by default (`DEFAULT_DEDUPE_TTL_MS`). |
| Retries | Resend retries a non-2xx answer for about 27 hours. Then it disables the endpoint. |

### Event mapping

| Resend event | Normalized event |
|---|---|
| `email.delivered` | `delivered` |
| `email.bounced` with bounce type `Permanent` | `bounced`, `bounce: "hard"` |
| `email.bounced` with another bounce type | `bounced`, `bounce: "soft"` |
| `email.complained` | `complained` |
| Any other type, such as `email.failed` | `unknown`, with the Resend type in `rawType` |

`recipient` is set only when the email had exactly one `to` address. `providerMessageId` is the Resend email ID. It matches the `providerMessageId` of the `sent` result.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `createMailer` throws "invalid credentials: apiKey (pattern)" | The key does not start with `re_`. | Copy the key again from Resend. |
| Sends return `not_sent/auth` | The key is wrong, revoked, or from another team. | Create a new key. |
| Sends return `not_sent/quota` | The daily or monthly quota is used up. | Wait for the reset, or upgrade the plan. The fallback provider sends in the meantime. |
| Sends return `unknown/idempotency_conflict` | The key was used before with a different message. | Use a new key for a different message. See [deterministic message bytes](../guides/delivery-safety.md#deterministic-message-bytes). |
| Webhooks get 401 | The secret does not match the endpoint, or the clock of the request is more than 5 minutes off. | Copy the secret from the webhook in Resend. |

## Sources

Last checked: 2026-10-26

- [Send email](https://resend.com/docs/api-reference/emails/send-email)
- [Send batch emails](https://resend.com/docs/api-reference/emails/send-batch-emails)
- [Errors](https://resend.com/docs/api-reference/errors)
- [Idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Rate limit](https://resend.com/docs/api-reference/rate-limit)
- [Webhook event types](https://resend.com/docs/dashboard/webhooks/event-types)
- [Verify webhook requests](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests)
- [Webhook retries and replays](https://resend.com/docs/webhooks/retries-and-replays)
- [Svix manual verification](https://docs.svix.com/receiving/verifying-payloads/how-manual)
