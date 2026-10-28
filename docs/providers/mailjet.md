# Mailjet

Last checked: 2026-10-27

The Mailjet adapter is in `mailswitch/mailjet`. It is a tier 1 provider. It sends email with attachments, sends batches of up to 50 messages, checks the API keys, and reads Mailjet webhook requests.

The Mailjet free plan sends 6,000 emails each month and at most 200 emails each day. mailswitch sets no daily cap for Mailjet. Set a cap in the mailer if your plan has one.

## Set up the adapter

```ts
import { mailjet } from "mailswitch/mailjet";

declare const env: { MAILJET_API_KEY: string; MAILJET_SECRET_KEY: string };

const adapter = mailjet({ apiKey: env.MAILJET_API_KEY, secretKey: env.MAILJET_SECRET_KEY });
```

| Option | Use |
|---|---|
| `apiKey` | The API key. The `apiKey` credential takes precedence. |
| `secretKey` | The secret key. The `secretKey` credential takes precedence. |
| `baseUrl` | The API origin. The default is `https://api.mailjet.com`. It must be an https URL. Plain http works only for a loopback host, for tests. |
| `sandbox` | When `true`, each request sets `SandboxMode: true`. Mailjet checks the request and delivers no email. |
| `webhookUsername` | The Basic auth username of the webhook. The default is `mailswitch`. |
| `previousWebhookSecret` | The webhook secret before a rotation. See [Rotate the webhook secret](#rotate-the-webhook-secret). |

Mailjet documents only the `api.mailjet.com` host for the Send API. The SDK docs name a US host, `api.us.mailjet.com`, for accounts on the US platform. Set `baseUrl` to that host only if your account is on it.

A sandbox answer has no message id. mailswitch gives `sent` with no `providerMessageId`.

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | The API key: 20 to 64 letters and digits. |
| `secretKey` | Yes | Yes | The secret key of the same API key: 20 to 64 letters and digits. |

Find the keys in the Mailjet app, under **Account settings**, then **REST API**, then **API key management**. Mailjet shows the secret key only once. mailswitch sends the keys with HTTP Basic auth. The API key is the username, and the secret key is the password.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /v3.1/send` with one message in `Messages` |
| `sendBatch` | `POST /v3.1/send` with up to 50 messages in `Messages` |
| `verify` | `GET /v3/REST/user`. It sends no email. |

An attachment with a `contentId` goes to `InlinedAttachments`, with the content id in `ContentID`. Other attachments go to `Attachments`. Custom headers go to `Headers`.

Limits:

- One request body can be at most 15 MB, with every attachment in base64. mailswitch refuses a message whose request entry is larger, as `not_sent/unsupported`, before any request.
- One request holds at most 50 messages. The mailer splits a larger batch into chunks of 50. The adapter also splits a chunk into more requests when the bodies together are larger than 15 MB.
- Mailjet has a limit on the recipients of one message, but it does not give the number. mailswitch allows 50 recipients in To, Cc, and Bcc together. It refuses a larger message as `not_sent/unsupported`.
- Mailjet allows at most 50 items in an array property, for example `Attachments` or `Headers`. A message with more gets a 400 error entry, which is `not_sent/invalid_message`.
- Mailjet has no idempotency key. `CustomID` is only a tag, and mailswitch does not set it. Use an idempotency store in the mailer to stop a duplicate send.

### Delivery status

Mailjet handles each message of a request on its own. One answer can hold success entries and error entries. When the answer body has a `Messages` array, each entry decides the result of its message, in order. This is true for any HTTP status.

| Entry in `Messages` | Status and reason |
|---|---|
| `Status: success` | `sent`. The message id is `To[0].MessageUUID`. |
| `Status: error`, and every `Errors[]` entry has a 4xx `StatusCode` | `not_sent`. The reason comes from the first `StatusCode`, with the table below. |
| `Status: error`, and an `Errors[]` entry has a 5xx `StatusCode` or no `StatusCode` | `unknown/provider_error` |
| No entry for the message, or another `Status` | `unknown/provider_error` |

When the body has no `Messages` array, the HTTP status decides:

| Mailjet answer | Status and reason |
|---|---|
| 2xx with no `Messages` array, or a body that is not JSON | `unknown/provider_error` |
| 400, for example `mj-0002` (malformed JSON) | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| Other 4xx | `not_sent/rejected` |
| 429 | `not_sent/rate_limited`. Mailjet documents no `Retry-After` header, so the result has no `retryAfterMs`. |
| 500, 502, 503, 504 | `unknown/provider_error` |
| Timeout or network error | `unknown` |

A request with two or more messages and no `Messages` array is `unknown/provider_error` for each message, because some of them may have sent. A global error object with an `ErrorCode` such as `mj-0002`, a 401, a 403, and a 429 still use the table above.

All requests of one `send` or `sendBatch` call share one deadline of `timeoutMs`. After a timeout or a network error, mailswitch sends no more requests. Each message of the remaining requests is then `unknown`. When no time is left before a request, its messages are `unknown/timeout`.

A 401 for wrong keys has an HTML body. mailswitch reads a body only as JSON, and it never copies a body into a result. A result message holds the `StatusCode` and the `ErrorCode`, for example `send-0008`, and never the `ErrorMessage`.

No Mailjet document states that a 5xx sent nothing. So every 5xx is `unknown`. Do not retry and do not fall back after `unknown`.

## Webhooks

Mailjet does not sign webhooks. You put HTTP Basic auth credentials in the webhook URL, for example `https://mailswitch:<secret>@app.example.com/hooks/mailjet`. Mailjet sends them in the `Authorization` header. mailswitch uses the password as the webhook secret.

The secret gives no timestamp binding and no body binding:

- Basic auth covers no timestamp. mailswitch cannot tell an old request from a new one, so the `stale` check does not apply. Mailjet also retries a failed request every 30 seconds for 24 hours. Use a dedupe store.
- Basic auth covers no body. The password proves only that the sender knows the secret. A person who reads one request can send a changed body with the same header.
- The URL must use HTTPS. Over plain HTTP, anybody on the network path can read the secret.

### Make the secret

The secret must hold at least 128 bits. mailswitch checks the length:

- A secret of only hex characters needs at least 32 characters.
- Any other secret needs at least 22 characters, for example 22 base64url characters.

Do not type a secret by hand. Make it with `generateMailjetWebhookSecret()`, which gives 256 random bits as 43 base64url characters. The base64url characters are safe in a URL.

A secret that is too short is a setup error. The webhook check refuses each request as `invalid_secret`, which maps to HTTP 500. The provider retries after you fix the secret. A weak `previousWebhookSecret` throws a `TypeError` when you create the adapter. The message does not hold the secret.

### Set up the webhook in Mailjet

1. Make the webhook URL with `mailjetWebhookUrl(endpoint, secret)`. The endpoint must be an https URL.
2. In the Mailjet app, open **Account settings**, then **Event notifications (webhooks)**.
3. Enter the URL for the **Sent**, **Bounce**, **Spam**, and **Unsub** events. You can add other events. mailswitch gives them the type `unknown`.
4. Turn on **Group events**. Mailjet then sends a list of events in one request (`Version` 2). mailswitch also reads one event object (`Version` 1).
5. Store the secret as the webhook secret, for example in `MAILJET_WEBHOOK_SECRET`.

```ts
import { generateMailjetWebhookSecret, mailjetWebhookUrl } from "mailswitch/mailjet";

const secret = generateMailjetWebhookSecret();
const url = mailjetWebhookUrl("https://app.example.com/hooks/mailjet", secret);
console.log(url);
```

### Handle a webhook

The Mailjet adapter needs a dedupe store. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import type { DedupeStore } from "mailswitch";
import { mailjet } from "mailswitch/mailjet";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(request: Request, env: { MAILJET_WEBHOOK_SECRET: string }): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: mailjet(),
      secret: env.MAILJET_WEBHOOK_SECRET,
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

The dedupe keys stay for 30 days by default. Mailjet stops its retries after 24 hours, so a retry always finds its key.

### How the check works

- The scheme name is read without regard to case.
- mailswitch compares the SHA-256 digest of the username and the SHA-256 digest of the password separately. Each compare takes the same time for any input.
- A wrong username with the right password is refused.
- A missing header, a different scheme, a wrong password, or an empty secret gives `bad_signature`.
- A header that cannot be decoded gives `malformed`. A body that is not one event object or a list of event objects also gives `malformed`.

### Rotate the webhook secret

1. Make a new secret.
2. Set the old secret in `previousWebhookSecret`, and set the new secret as the `secret` of `handleWebhook`. Deploy.
3. Change the webhook URL in Mailjet to a URL with the new secret.
4. Wait for 24 hours, so that Mailjet stops the retries of requests with the old secret.
5. Remove `previousWebhookSecret`. Deploy.

While `previousWebhookSecret` is set, both secrets pass. The previous secret must also hold 128 bits.

### Events

| Mailjet event | Normalized event |
|---|---|
| `sent` | `delivered`. Mailjet sends it when the destination mail server accepts the message. |
| `bounce` with `hard_bounce: true` | `bounced`, `hard` |
| `bounce` with any other `hard_bounce` value | `bounced`, `soft` |
| `spam` | `complained` |
| `unsub` | `unsubscribed` |
| Any other event, for example `blocked`, `open`, or `click` | `unknown` |

`rawType` is the `event` field. `recipient` is `email`. `occurredAt` is `time` in milliseconds.

`providerMessageId` is `Message_GUID`. When an event has no `Message_GUID`, it is the `MessageID` digits. The Mailjet docs do not state that `Message_GUID` equals the `MessageUUID` of the send answer. Check this with your account before you match events to sends.

Mailjet sends no event id. The event key is `<event>:<MessageID>:<email>:<time>`, with the email in lowercase. A `click` event also adds its `url`. These fields do not change when Mailjet sends the same request again. `MessageID` can be larger than a safe JavaScript number, so mailswitch reads its digits from the raw body. When one request holds the same key twice, mailswitch keeps one event.

### Bounce detail

A `bounced` event carries `bounceDetail` when Mailjet sends these fields:

- `text`: `error`, with `error_related_to` in parentheses when it is present.

The Mailjet docs do not confirm these field names. mailswitch reads them as optional. The text comes from a remote mail server and can hold personal data. mailswitch does not escape markup in it. Escape the text before you show it.

To check the field names, put a raw bounce body from Mailjet in `MAILSWITCH_LIVE_MAILJET_BOUNCE_BODY` and run the live smoke test. The test logs which fields are present. It never logs their values.

## Links

- [Send API v3.1](https://dev.mailjet.com/openapi/openapi-mailjet/send-emails/postsendv31.md)
- [Send API errors](https://dev.mailjet.com/docs/email-api/send-api-v31/send-api-errors.md)
- [Webhooks overview](https://dev.mailjet.com/docs/email-api/webhooks/webhooks-overview.md)
- [Webhook event types](https://dev.mailjet.com/docs/email-api/webhooks/event-types.md)
- [Pricing](https://www.mailjet.com/pricing/)
