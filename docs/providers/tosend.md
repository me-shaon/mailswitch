# toSend

Last checked: 2026-10-26

| Item | Value |
|---|---|
| Import | `mailswitch/tosend` |
| Adapter | `tosend(options?)` |
| Meta | `toSendMeta` (also in `mailswitch/catalog` as `tosend`) |
| Tier | 1 |
| Native idempotency | No. Use an idempotency store. |
| Webhooks | Yes. HMAC-SHA256 over the raw body, with no signed timestamp. A dedupe store is required. |

toSend is a pay-as-you-go service for transactional email, such as receipts, password resets, and notifications. It has no subscription. The toSend API is in early access, so check the sources below when a send fails in a new way.

## Setup

1. Create an account at https://tosend.com.
2. Add your sending domain. Add the DKIM, SPF, and MX records that toSend shows.
3. Wait until toSend shows the domain as verified.
4. Create an API key. A sending key starts with `tsend_`. An admin key starts with `tsend_admin_` and needs the `emails:send` scope to send.
5. Store the key as a Worker secret, for example `TOSEND_API_KEY`.

## Credentials

| Field | Label | Secret | Required | Rule |
|---|---|---|---|---|
| `apiKey` | API key | Yes | Yes | Matches `^tsend_[A-Za-z0-9_]+$` |

```ts
import { createMailer } from "mailswitch";
import { D1IdempotencyStore } from "mailswitch/stores/d1";
import { tosend } from "mailswitch/tosend";

declare const env: { DB: D1Database; TOSEND_API_KEY: string };

const mailer = createMailer({
  providers: [{ adapter: tosend(), credentials: { apiKey: env.TOSEND_API_KEY } }],
  namespace: "my-app",
  idempotency: new D1IdempotencyStore(env.DB),
});
```

`tosend()` takes two optional options:

- `apiKey`: the key, for code that calls the adapter directly. A key in the credentials takes precedence.
- `baseUrl`: the API base URL. It defaults to `https://api.tosend.com`. It must be an https URL. Plain http works only for a loopback host, for tests.

### Verify

`adapter.verify(ctx)` calls `GET /v2/info`. This call sends no email. A failure returns `ok: false` with a status and a reason, as a send would.

## Capabilities and limits

| Capability | Value |
|---|---|
| Attachments | Yes |
| Largest message | 10 MB. mailswitch checks the size after base64 encoding, which is the safe side. |
| Recipients | At most 50 across `to`, `cc`, and `bcc` |
| Cc, Bcc, Reply-To | Yes |
| Custom headers | Yes, sent unchanged |
| Batch size | 50 emails per `POST /v2/emails/batch` request |
| Attachments in a batch | Yes |

mailswitch refuses a message that breaks a limit before any network call. The result is `not_sent` with the reason `unsupported`, so the fallback provider can try the message.

toSend limits that mailswitch does not enforce:

| Limit | Value | What to do |
|---|---|---|
| Rate limit | 10 batch requests per second per team, over a 10-second window | A 429 gives `not_sent/rate_limited` with `retryAfterMs` from `Retry-After`. |
| Credits | toSend counts the recipients of a request first. A low balance fails the whole request with 403. | The result is `not_sent/credits`. Add credits. |

## Status mapping

The adapter uses the default table of the classifier (see [Delivery safety](../guides/delivery-safety.md#status-table)). The status map has no overrides.

toSend answers 403 for a wrong key and for an empty balance. The default reason for 403 is `auth`. When the response text names credits, the adapter changes the reason to `credits`. The status stays `not_sent`, and the result message never copies the response body.

### Batch results

`POST /v2/emails/batch` answers 200 when every email is accepted, and 207 when some fail. Each entry of the response maps to one result:

| Entry | Result |
|---|---|
| `status: "success"` | `sent`, with the `message_id` as `providerMessageId` |
| `status: "spam"` | `not_sent/rejected` |
| `status: "error"` with a code below 500 | `not_sent/invalid_message` |
| Any other entry, or a missing entry | `unknown/provider_error` |

## Idempotency

toSend has no idempotency key. A retry after a timeout can send a second copy, unless the mailer has an idempotency store.

- With a store, mailswitch claims the key before the first send. A retry with the same key gets the stored result and makes no network call. See [Delivery safety](../guides/delivery-safety.md#idempotency-record-lifecycle).
- Without a store, `createMailer` writes a warning to the logger: a keyed send through toSend can go out twice on a retry.

Always set an idempotency store when toSend is in the chain.

## Webhooks

toSend signs the raw body with HMAC-SHA256 and sends the hex digest in the `X-ToSend-Signature` header as `sha256=<hex>`. The signature covers no timestamp. A replayed body passes the signature check, so the dedupe store is the only replay protection.

### Set up the endpoint

1. In the toSend dashboard, open **Webhooks** and select **Create Webhook**.
2. Enter the URL of your webhook route, for example `https://app.example.com/webhooks/tosend`.
3. Set a secret. Make a long random value. toSend sends the signature only when the webhook has a secret.
4. Select the **Bounced** and **Complaint** events.
5. Select **Create Webhook**.
6. Store the same secret as a Worker secret, for example `TOSEND_WEBHOOK_SECRET`.

### Handle the events

The [README webhook example](../../README.md#receive-webhooks) uses toSend. The `tosend()` adapter has `requiresDedupe: true`, so the types of `handleWebhook` refuse a call without a `dedupe` store. A call without a store also throws a `TypeError` at run time.

| Item | Value |
|---|---|
| Signature header | `X-ToSend-Signature: sha256=<hex>` |
| Secret | The secret that you set on the webhook. An empty secret refuses every request. |
| Signed timestamp | No |
| Event key | The SHA-256 of the raw body. A body with an array of events gives one key per item. |
| Dedupe store | Required |
| Dedupe TTL | 30 days by default (`UNSIGNED_TIMESTAMP_TTL_MS`). A replay after the TTL is delivered again. |
| Retries | None. toSend sends each event once. It logs a failure after a non-2xx answer or after 10 seconds. |

Because toSend does not retry, a non-2xx answer loses that event. When your handler fails, check the toSend **Logs** page (kept 14 days) and the toSend suppression list. Add the addresses to your own suppression list by hand.

### Event mapping

| toSend event | Normalized event |
|---|---|
| `bounced` with `is_hard_bounce: true`, or bounce type `Permanent` | `bounced`, `bounce: "hard"` |
| `bounced` in other cases | `bounced`, `bounce: "soft"` |
| `complaint` | `complained` |
| `delivered` | `delivered` |
| Any other type | `unknown`, with the toSend type in `rawType` |

toSend documents only the bounce and complaint events. It sends no delivery events.

### Bounce detail

A `bounced` event carries `bounceDetail` when toSend sends these fields:

- `text`: `data.reason`.

toSend also puts `reason` on a complaint. mailswitch reads it only for a bounce. The text comes from a remote mail server and can hold personal data. mailswitch does not escape markup in it. Escape the text before you show it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `createMailer` throws "invalid credentials: apiKey (pattern)" | The key does not start with `tsend_`. | Copy the key again from toSend. |
| Sends return `not_sent/auth` | The key is wrong or disabled. | Create a new key. |
| Sends return `not_sent/credits` | The balance cannot cover the request. | Add credits in toSend. |
| Webhooks get 401 | The secret in toSend does not match, or no secret is set. | Set the same secret in toSend and in your Worker. |
| Bounces are missing after an outage | toSend does not retry webhooks. | Check the toSend **Logs** page and the suppression list. |

## Sources

Last checked: 2026-10-26

- [Send email](https://tosend.com/docs/api/send-email/)
- [Batch emails](https://tosend.com/docs/api/batch-emails/)
- [API introduction (keys, rate limits, errors)](https://tosend.com/docs/api/introduction/)
- [Webhooks guide](https://tosend.com/docs/guide/webhooks/)
- [Admin API (scopes)](https://tosend.com/docs/api/admin-api/)
- [Pricing](https://tosend.com/pricing)
