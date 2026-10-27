# SMTP2GO

Last checked: 2026-10-27

The SMTP2GO adapter is in `mailswitch/smtp2go`. It is a tier 1 provider. It sends email with attachments and inline images, checks the API key, and reads SMTP2GO webhook requests.

The SMTP2GO free plan sends 1,000 emails each month and at most 200 emails each day. With no verified sender domain, the limit is 25 emails each hour. mailswitch sets no daily cap for SMTP2GO. Set a cap in the mailer if your plan has one.

## Set up the adapter

```ts
import { smtp2go } from "mailswitch/smtp2go";

declare const env: { SMTP2GO_API_KEY: string };

const adapter = smtp2go({ apiKey: env.SMTP2GO_API_KEY, region: "eu" });
```

| Option | Use |
|---|---|
| `apiKey` | The API key. The `apiKey` credential takes precedence. |
| `region` | The region host: `us`, `eu`, or `au`. Without it, the adapter uses the regionless host `api.smtp2go.com`. Any other value throws a `TypeError`. |
| `baseUrl` | The API origin, for tests or a proxy. It replaces the region host. It must be an https URL. Plain http works only for a loopback host. |
| `webhookUsername` | The Basic auth username of the webhook. The default is `mailswitch`. |
| `previousWebhookSecret` | The webhook secret before a rotation. See [Rotate the webhook secret](#rotate-the-webhook-secret). |

| Region | Host |
|---|---|
| (none) | `https://api.smtp2go.com` |
| `us` | `https://us-api.smtp2go.com` |
| `eu` | `https://eu-api.smtp2go.com` |
| `au` | `https://au-api.smtp2go.com` |

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | `api-` and 32 letters and digits. |

Make the key in the SMTP2GO app, under **Sending**, then **API Keys**. Give the key the permission for `/email/send`. mailswitch sends the key in the `X-Smtp2go-Api-Key` header. It never puts the key in the request body.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /v3/email/send` |
| `verify` | `POST /v3/api_keys/permissions` with the body `{}`. It sends no email. |

The adapter has no `sendBatch`. The mailer sends a batch with one request for each message.

The request body:

- `sender`, `to`, `cc`, and `bcc` hold addresses as `Name <addr>` text.
- `text_body` and `html_body` hold the bodies.
- Custom headers go to `custom_headers`. SMTP2GO has no reply-to field, so mailswitch adds a `Reply-To` entry to `custom_headers`.
- An attachment with no `contentId` goes to `attachments`.
- An attachment with a `contentId` goes to `inlines`. SMTP2GO links an inline image as `cid:<filename>`. So mailswitch sends the `contentId` as the `filename` of the inline image. Use `<img src="cid:logo">` for an attachment with `contentId: "logo"`. SMTP2GO does not get the `filename` of an inline attachment.
- `fastaccept` is always `false`. With `true`, SMTP2GO answers before it sends, and the answer has no result.

Limits:

- An email can be at most 50 MB, with content, attachments, and headers. mailswitch refuses a larger message as `not_sent/unsupported`, before any request.
- Each of `to`, `cc`, and `bcc` takes at most 100 addresses. mailswitch refuses a message with more as `not_sent/unsupported`, before any request.
- SMTP2GO has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.

### Delivery status

SMTP2GO answers HTTP 200 even when it sent nothing. So mailswitch reads the counts in the 200 body. The counts are for the email. They are not for each recipient.

| SMTP2GO answer | Status and reason |
|---|---|
| 200 with `succeeded` above 0 | `sent`. The message id is `email_id`. This is also true when `failed` is above 0. |
| 200 with `succeeded: 0` and `failed` above 0 | `not_sent/rejected` |
| 200 with no counts, zero counts, or a body that is not JSON | `unknown/provider_error` |
| 400 with an error that names the API key | `not_sent/auth` |
| Other 400 | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| 402 ("the request failed") | `not_sent/rejected` |
| Other 4xx | `not_sent/rejected` |
| 429 | `not_sent/rate_limited`, with `retryAfterMs` 60000 |
| 500, 502, 503, 504 | `unknown/provider_error` |
| Timeout or network error | `unknown` |

A wrong API key gets HTTP 400, not 401. mailswitch reads the 400 body and gives `auth` only for these errors:

- `E_ApiResponseCodes.API_EXCEPTION` or `E_ApiResponseCodes.INVALID_IN_PAYLOAD`, with an `error` text that names `'api_key'`.
- `E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED`. The key has no permission for the endpoint.

A missing key gets HTTP 403. A result message holds the `error_code`, and never the `error` text or the `failures` list.

SMTP2GO sends no `Retry-After` header with a 429. Its docs say that the time-out is "no less than 1 minute". So mailswitch sets `retryAfterMs` to 60000. A `Retry-After` header, when it is present, takes precedence.

No SMTP2GO document states that a 5xx sent nothing. So every 5xx is `unknown`. Do not retry and do not fall back after `unknown`.

### Verify

`verify` reads the permissions of the API key. SMTP2GO makes this call available to all API keys.

- A list with `/email/send` is `ok`.
- A list without `/email/send` is `not_sent/auth`. The key cannot send email.
- A wrong key is `not_sent/auth`.

### Sandbox mode

SMTP2GO has no sandbox flag in the request. Sandbox mode is a setting of each API key in the SMTP2GO app. In sandbox mode, SMTP2GO accepts the email and marks it as rejected. It does not deliver the email, but the email counts against your quota. mailswitch cannot see this mode in the answer.

## Webhooks

SMTP2GO does not sign webhooks. A webhook can send an `Authorization` header with a Bearer token or Basic credentials. mailswitch uses the token, or the Basic password, as the webhook secret.

The secret gives no timestamp binding and no body binding:

- The token covers no timestamp. mailswitch cannot tell an old request from a new one, so the `stale` check does not apply. SMTP2GO also retries a failed request for up to 48 hours. Use a dedupe store.
- The token covers no body. The token proves only that the sender knows the secret. A person who reads one request can send a changed body with the same header.
- The URL must use HTTPS. Over plain HTTP, anybody on the network path can read the secret.

### Make the secret

The secret must hold at least 128 bits. mailswitch checks the length:

- A secret of only hex characters needs at least 32 characters.
- Any other secret needs at least 22 characters, for example 22 base64url characters.

Do not type a secret by hand. Make it with `generateSmtp2goWebhookSecret()`, which gives 256 random bits as 43 base64url characters.

A secret that is too short is a setup error. The webhook check throws a `TypeError`, and the message does not hold the secret.

### Set up the webhook in SMTP2GO

1. Make a secret, and store it as the webhook secret, for example in `SMTP2GO_WEBHOOK_SECRET`.
2. Get the auth fields with `smtp2goWebhookAuth(secret)`. The default type is `bearer`, and the value is the secret.
3. Add the webhook in the SMTP2GO app, under **Settings**, then **Webhooks**. You can also use `POST /v3/webhook/add`.
4. Set the URL to your https endpoint.
5. Set the output format to **JSON** (`output_format: "json"`). The default is form encoded. mailswitch refuses a form body as `malformed`.
6. Set `auth_header_type` and `auth_header_value` from step 2.
7. Select the `delivered`, `bounce`, and `spam` events. You can add other events. mailswitch gives them the type `unknown`.

```ts
import { generateSmtp2goWebhookSecret, smtp2goWebhookAuth } from "mailswitch/smtp2go";

const secret = generateSmtp2goWebhookSecret();
const body = {
  url: "https://app.example.com/hooks/smtp2go",
  output_format: "json",
  events: ["delivered", "bounce", "spam"],
  ...smtp2goWebhookAuth(secret),
};
console.log(JSON.stringify(body));
```

For Basic auth, use `smtp2goWebhookAuth(secret, "basic")`. The value is the base64 of `mailswitch:<secret>`. Credentials in the webhook URL, for example `https://mailswitch:<secret>@app.example.com/hooks/smtp2go`, also give a Basic header.

### Handle a webhook

The SMTP2GO adapter needs a dedupe store. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import type { DedupeStore } from "mailswitch";
import { smtp2go } from "mailswitch/smtp2go";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(request: Request, env: { SMTP2GO_WEBHOOK_SECRET: string }): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: smtp2go(),
      secret: env.SMTP2GO_WEBHOOK_SECRET,
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

The dedupe keys stay for 30 days by default. SMTP2GO stops its retries after 48 hours, so a retry always finds its key.

### How the check works

- The scheme name is read without regard to case. Bearer and Basic both pass.
- For Bearer, mailswitch compares the SHA-256 digest of the token with the digest of the secret. For Basic, it also compares the digest of the username. Each compare takes the same time for any input.
- A wrong Basic username with the right password is refused.
- A missing header, a different scheme, a wrong token, or an empty secret gives `bad_signature`.
- A header that cannot be decoded gives `malformed`. A body that is not one JSON event object or a list of JSON event objects also gives `malformed`.

### Rotate the webhook secret

1. Make a new secret.
2. Set the old secret in `previousWebhookSecret`, and set the new secret as the `secret` of `handleWebhook`. Deploy.
3. Change `auth_header_value` of the webhook in SMTP2GO to the new value.
4. Wait for 48 hours, so that SMTP2GO stops the retries of requests with the old secret.
5. Remove `previousWebhookSecret`. Deploy.

While `previousWebhookSecret` is set, both secrets pass. The previous secret must also hold 128 bits.

### Events

| SMTP2GO event | Normalized event |
|---|---|
| `delivered` | `delivered` |
| `bounce` with `bounce: "hard"` | `bounced`, `hard` |
| `bounce` with `bounce: "soft"` | `bounced`, `soft` |
| `bounce` with no `hard` or `soft` value | `bounced`, with no bounce class |
| `spam` | `complained` |
| Any other event, for example `processed`, `open`, `click`, `unsubscribe`, `resubscribe`, or `reject` | `unknown` |

`rawType` is the `event` field. `recipient` is `rcpt`. `providerMessageId` is `email_id`, the id of the send answer. `occurredAt` is `time` in milliseconds. mailswitch reads `time` as a date text or as a Unix time.

The event key is the `id` field, the unique id of the webhook event. When an event has no `id`, the key is `<event>:<email_id>:<rcpt>:<time>`, with the address in lowercase. When one request holds the same key twice, mailswitch keeps one event.

## Links

- [Send a standard email](https://developers.smtp2go.com/reference/send-standard-email.md)
- [Getting started](https://developers.smtp2go.com/docs/getting-started.md)
- [Response codes](https://developers.smtp2go.com/docs/response-codes)
- [Rate limiting](https://developers.smtp2go.com/docs/rate-limiting.md)
- [View API key permissions](https://developers.smtp2go.com/reference/view-api-key-permissions.md)
- [Webhooks overview](https://developers.smtp2go.com/docs/webhooks-overview.md)
- [Add a webhook](https://developers.smtp2go.com/reference/add-webhook.md)
