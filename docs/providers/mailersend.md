# MailerSend

Last checked: 2026-10-27

The MailerSend adapter is in `mailswitch/mailersend`. It is a tier 1 provider. It sends email with attachments, checks the API token, and reads signed MailerSend webhook requests.

The MailerSend free plan sends 500 emails each month and at most 100 emails each day. mailswitch sets no daily cap for MailerSend. Set a cap in the mailer if your plan has one.

## Set up the adapter

```ts
import { mailersend } from "mailswitch/mailersend";

declare const env: { MAILERSEND_API_TOKEN: string };

const adapter = mailersend({ apiKey: env.MAILERSEND_API_TOKEN });
```

| Option | Use |
|---|---|
| `apiKey` | The API token. The `apiKey` credential takes precedence. |
| `baseUrl` | The API origin. The default is `https://api.mailersend.com`. It must be an https URL. Plain http works only for a loopback host, for tests. |

MailerSend has no sandbox mode. Each successful send delivers a real email.

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | An API token. New tokens start with `mlsn.`. |

Make the token in the MailerSend app, under **Integrations**, then **API tokens**. MailerSend shows the token only once. Give the token full access to **Email**.

The MailerSend docs name no permission for `GET /v1/api-quota`. If a token that can send fails `verify` with a 403, give the token more read access. mailswitch gives a 403 as `not_sent/auth`.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /v1/email` |
| `verify` | `GET /v1/api-quota`. It sends no email, and it does not count against the daily API quota. |

An attachment with a `contentId` goes out as an inline attachment. Its `id` is the content id. MailerSend has no content type field for an attachment. It reads the type from the file name.

Limits:

- A message can have at most 50 To, 10 Cc, and 10 Bcc recipients. mailswitch refuses a larger message as `not_sent/unsupported` before any request.
- One attachment can be at most 25 MB. mailswitch checks the whole message after encoding against 25 MB.
- Custom headers need the Professional plan or higher. A lower plan gets a 422, which is `not_sent/invalid_message`.
- MailerSend has no batch endpoint with a result for each message. The mailer sends one request for each message.
- MailerSend has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.

### Delivery status

| MailerSend answer | Status and reason |
|---|---|
| 202 with an `x-message-id` header | `sent`. The message id is the header value. |
| 202 with the `SOME_SUPPRESSED` warning and an `x-message-id` | `sent`. MailerSend sent the email to the recipients that are not suppressed. |
| 202 with `x-send-paused: true` and an `x-message-id` | `sent`. See [Paused sending](#paused-sending). |
| 202 with the `ALL_SUPPRESSED` warning | `not_sent/rejected`. MailerSend suppressed every recipient and sent nothing. |
| 202 with no `x-message-id` and no warning | `unknown/provider_error` |
| 202 with a body that mailswitch cannot read | `unknown/provider_error` |
| 400 | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| 404, 405 | `not_sent/rejected` |
| 408 | `unknown/provider_error` |
| 421 | `unknown/provider_error` |
| 422 | `not_sent/invalid_message`. Some `#MS` codes change the reason. See below. |
| 429 | `not_sent/rate_limited`. `retryAfterMs` comes from the `retry-after` header. |
| 500, 502, 503, 504 | `unknown/provider_error` |
| Timeout or network error | `unknown` |

A 422 body holds a `#MS` code at the end of each error text. mailswitch reads these codes:

| Code | Meaning | Reason |
|---|---|---|
| `#MS42207` | The domain of `from` is not verified. | `rejected` |
| `#MS42204` | The plan email limit or your own limit is reached. | `quota` |
| `#MS42222` | The trial domain email quota is reached. | `quota` |
| `#MS42242` | The monthly overage limit is reached. | `quota` |

MailerSend documents 408 and 421 as faults on its side, and it does not state that the message did not go out. So 408, 421, and every 5xx are `unknown`. Do not retry and do not fall back after `unknown`.

### Paused sending

MailerSend can pause the sending of an account. A paused account still answers 202 with an `x-message-id`, and it adds the `x-send-paused: true` header. MailerSend keeps the email and sends it when the account sends again. mailswitch gives `sent`, because MailerSend accepted the email. Look at the MailerSend app when emails do not arrive.

## Webhooks

MailerSend signs each webhook request with HMAC-SHA256 and the signing secret of the webhook. The `Signature` header holds the hex digest of the raw body.

The signature covers no timestamp. mailswitch cannot tell an old request from a new one, so the `stale` check does not apply. A person who gets a copy of a signed request can send it again at any time. Thus:

- Use an HTTPS URL for the webhook endpoint.
- Use a dedupe store. MailerSend also retries a failed request for up to about 3 days, and each retry has the same body and signature.

### Set up the webhook in MailerSend

1. In the MailerSend app, open **Domains** under **Email**. Click **Manage** next to the sending domain.
2. In **Webhooks**, click **Add webhook**. Enter a name and the HTTPS URL of your endpoint.
3. Select the webhook version **V2**. mailswitch also reads the fields of the older payload shape.
4. Select **activity.delivered**, **activity.soft_bounced**, **activity.hard_bounced**, and **activity.spam_complaint**. You can select other events. mailswitch gives them the type `unknown`.
5. Save the webhook. Open it again and copy its signing secret.
6. Store the signing secret as the webhook secret, for example in `MAILERSEND_WEBHOOK_SECRET`.

### Handle a webhook

The MailerSend adapter needs a dedupe store. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import type { DedupeStore } from "mailswitch";
import { mailersend } from "mailswitch/mailersend";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(request: Request, env: { MAILERSEND_WEBHOOK_SECRET: string }): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: mailersend(),
      secret: env.MAILERSEND_WEBHOOK_SECRET,
      dedupe,
    });
    if (!outcome.ok) return new Response(null, { status: outcome.status });
    for (const event of outcome.events) {
      console.log(event.type);
    }
    await outcome.ack();
    return new Response(null, { status: 200 });
  },
};
```

### How the check works

- mailswitch reads the `Signature` header. It must hold 64 hex characters.
- It computes the HMAC-SHA256 of the raw body bytes with the signing secret, and compares the two in constant time.
- A missing header, a wrong signature, or an empty secret gives `bad_signature`.
- A header that is not hex, or a body that is not one JSON object, gives `malformed`.

### Events

One request holds one event. mailswitch gives one normalized event.

| MailerSend type | Normalized event |
|---|---|
| `activity.delivered` | `delivered` |
| `activity.hard_bounced` | `bounced`, `hard` |
| `activity.soft_bounced` | `bounced`, `soft` |
| `activity.spam_complaint` | `complained` |
| Any other type, for example `activity.opened` or `activity.sent` | `unknown` |

The spam complaint example of MailerSend has the type `spam_complaints` in `data.type`. mailswitch reads the top-level `type`. It also accepts `activity.spam_complaints` there.

`rawType` is the top-level `type`. `recipient` is `data.recipient`. `providerMessageId` is `data.message_id`, which is the `x-message-id` value of the send. `occurredAt` is `created_at` in milliseconds.

The event key is `data.id`, the id of the activity. A body without it gets the SHA-256 of the raw body.

## Links

- [Email API](https://developers.mailersend.com/api/v1/email)
- [General: authentication, status codes, rate limits, and error codes](https://developers.mailersend.com/general)
- [Check the API quota](https://developers.mailersend.com/guides/checking-api-quota)
- [Webhooks](https://developers.mailersend.com/api/v1/account/webhooks)
- [Plans, features, and limits](https://www.mailersend.com/help/plans-features-and-limits)
