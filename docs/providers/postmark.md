# Postmark

Last checked: 2026-10-26

The Postmark adapter is in `mailswitch/postmark`. It is a tier 1 provider. It sends email with attachments, sends batches, checks the server token, and reads Postmark webhooks.

## Set up the adapter

```ts
import { postmark } from "mailswitch/postmark";

const adapter = postmark({ serverToken: env.POSTMARK_SERVER_TOKEN });
```

| Option | Use |
|---|---|
| `serverToken` | The server API token. The `serverToken` credential takes precedence. |
| `messageStream` | The message stream ID. The `messageStream` credential takes precedence. When both are empty, Postmark uses the `outbound` stream. |
| `baseUrl` | The API origin, for tests or a proxy. The default is `https://api.postmarkapp.com`. |
| `webhookUsername` | The Basic auth username of the webhook. The default is `mailswitch`. |
| `previousWebhookSecret` | The webhook secret before a rotation. See [Rotate the webhook secret](#rotate-the-webhook-secret). |

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `serverToken` | Yes | Yes | The token from the API Tokens tab of the Postmark server. |
| `messageStream` | No | No | Lowercase letters, digits, and hyphens, 1 to 30 characters. |

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /email` |
| `sendBatch` | `POST /email/batch`, up to 500 messages |
| `verify` | `GET /server`. It sends no email. |

Limits:

- A message can have at most 50 recipients in To, Cc, and Bcc.
- A message can be at most 10 MB after encoding.
- Postmark has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.

### Delivery status

| Postmark answer | Status and reason |
|---|---|
| 200 with `ErrorCode` 0 | `sent` |
| 401, or `ErrorCode` 10 | `not_sent/auth` |
| 422 with `ErrorCode` 413 or 1480 | `not_sent/auth` |
| 422 with `ErrorCode` 406 or 412 | `not_sent/rejected` |
| Other 422 | `not_sent/invalid_message` |
| 429 | `not_sent/rate_limited` |
| 500, 503, and every other 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

Postmark does not state that a message did not go out after a 5xx. So every 5xx is `unknown`. Do not retry and do not fall back after `unknown`.

A batch answers 200 with one entry for each message. Each entry gets its own result. An entry with `ErrorCode` 100 or 101, or a missing entry, is `unknown`.

## Webhooks

Postmark does not sign webhooks. It sends HTTP Basic auth credentials that you set on the webhook. mailswitch uses the password as the webhook secret.

### Make the secret

The secret must hold at least 128 bits. mailswitch checks the length:

- A secret of only hex characters needs at least 32 characters.
- Any other secret needs at least 22 characters, for example 22 base64url characters.

mailswitch cannot measure the real randomness of a secret. A long secret of one repeated character passes the length check. Do not type a secret by hand. Make it with `generatePostmarkWebhookSecret()`, which gives 256 random bits as 43 base64url characters.

A secret that is too short is a setup error. The webhook check throws a `TypeError`, and the message does not hold the secret.

### Set up the webhook in Postmark

1. Open the server in Postmark, then the message stream, then **Webhooks**.
2. Select **Add webhook**.
3. Enter the HTTPS URL of your endpoint.
4. Turn on **Basic auth credentials**.
5. Enter the username. The default is `mailswitch`.
6. Enter the secret as the password.
7. Select **Bounce**, **Spam complaint**, and **Delivery**. Save the webhook.

### Handle a webhook

The Postmark adapter needs a dedupe store. Basic auth covers no timestamp, so a replayed request passes the check. The dedupe store is the only replay guard. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import { postmark } from "mailswitch/postmark";
import { handleWebhook } from "mailswitch/webhooks";

const outcome = await handleWebhook(request, {
  adapter: postmark(),
  secret: env.POSTMARK_WEBHOOK_SECRET,
  dedupe,
});
if (!outcome.ok) return new Response(null, { status: outcome.status });
await handleEvents(outcome.events);
await outcome.ack();
return new Response(null, { status: 200 });
```

The dedupe keys stay for 30 days by default. A replay after that time passes again.

Basic auth does not cover the body. The password proves only that the sender knows the secret. Use HTTPS for the webhook URL, so nobody can read the secret or change the body.

### How the check works

- The scheme name is read without regard to case. `Basic`, `basic`, and `BASIC` all pass.
- mailswitch compares the SHA-256 digest of the username and the SHA-256 digest of the password separately. Each compare takes the same time for any input.
- A wrong username with the right password is refused.
- A missing header or a different scheme gives `bad_signature`. A header that cannot be decoded gives `malformed`.

### Rotate the webhook secret

1. Make a new secret.
2. Set the old secret in `previousWebhookSecret`, and set the new secret as the `secret` of `handleWebhook`. Deploy.
3. Change the password of the webhook in Postmark to the new secret.
4. Remove `previousWebhookSecret`. Deploy.

While `previousWebhookSecret` is set, both secrets pass. The previous secret must also hold 128 bits.

### Events

| Postmark record | Normalized event |
|---|---|
| `Bounce` with type `HardBounce`, `BadEmailAddress`, or `ManuallyDeactivated` | `bounced`, `hard` |
| `Bounce` with type `Transient`, `DnsError`, or `SoftBounce` | `bounced`, `soft` |
| `Bounce` with any other type, for example `AutoResponder` | `unknown` |
| `SpamComplaint` | `complained` |
| `Delivery` | `delivered` |
| Any other record, for example `Open` | `unknown` |

`rawType` is the Postmark `RecordType`.

The event key is `RecordType:ID`, for example `Bounce:692560173`. mailswitch reads the ID digits from the raw body, because a bounce ID can be larger than a safe JavaScript number. A `Delivery` record has no ID, so its key is `Delivery:<MessageID>:<recipient>`. Postmark reports one delivery for each recipient of a message. Any other record without an ID, for example `Open`, gets `<RecordType>:<MessageID>:<recipient>:<time>`. A `Click` record also adds its link. These fields do not change when Postmark sends the same request again.

## Links

- [Email API](https://postmarkapp.com/developer/api/email-api)
- [API overview and error codes](https://postmarkapp.com/developer/api/overview)
- [Webhooks overview](https://postmarkapp.com/developer/webhooks/webhooks-overview)
- [Bounce types](https://postmarkapp.com/developer/api/bounce-api#bounce-types)
