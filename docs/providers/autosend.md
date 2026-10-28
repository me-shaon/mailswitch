# AutoSend

Last checked: 2026-10-27

The AutoSend adapter is in `mailswitch/autosend`. It is a tier 1 provider. It sends email with attachments through the AutoSend API, checks the API key, and reads signed AutoSend webhook requests.

AutoSend allows 2 requests each second by default. A new sending domain starts at 300 emails each day. mailswitch sets no daily cap for AutoSend. Set a cap in the mailer while the domain warms up.

## Set up the adapter

```ts
import { autosend } from "mailswitch/autosend";

declare const env: { AUTOSEND_API_KEY: string };

const adapter = autosend({ apiKey: env.AUTOSEND_API_KEY });
```

| Option | Use |
|---|---|
| `apiKey` | The API key. The `apiKey` credential takes precedence. |
| `projectId` | The project ID. Only an account key needs it. The `projectId` credential takes precedence. |
| `baseUrl` | The API origin, for tests or a proxy. The default is `https://api.autosend.com`. It must be an https URL. Plain http works only for a loopback host, for tests. |

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | A project key starts with `AS_`. An account key starts with `ASA_`. The case of the prefix does not matter. |
| `projectId` | No | No | Printable ASCII with no space, 1 to 128 characters. |

mailswitch sends the key in the `Authorization: Bearer` header. Use a project key when you can. An account key also needs the project ID. mailswitch sends the project ID in the `x-project-id` header. An account key with no project ID gives `not_sent/auth` before any request.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST https://api.autosend.com/v1/mails/send` |
| `verify` | `GET https://api.autosend.com/v1/domains`. It sends no email. A 200 with an empty domain list is still `ok`. |

mailswitch sends each address as `{ email, name }`. Each attachment goes out with `fileName`, the base64 `content`, and `contentType`. Custom headers go out unchanged in `headers`.

### One To address

AutoSend takes one `to` address for each email. A message with more than one To address gives `not_sent/unsupported` before any request. Send one message for each To recipient. Cc and Bcc can hold more than one address.

mailswitch does not split a message into several sends. One message always gives one result.

### Limits

mailswitch refuses these messages as `not_sent/unsupported` before any request:

- More than 50 recipients across To, Cc, and Bcc.
- A message larger than 40 MB after base64 encoding. mailswitch uses 40,000,000 bytes.
- More than 20 attachments.
- An attachment with a `contentId`. AutoSend has no inline attachments.
- A subject longer than 998 characters.
- More than 20 custom headers.
- A header name that is not 1 to 76 letters, digits, or hyphens.
- A header value longer than 1000 characters.
- A reserved header: `From`, `To`, `Cc`, `Bcc`, `Subject`, `Date`, `Message-ID`, `Return-Path`, `Sender`, `Reply-To`, `Received`, `DKIM-Signature`, `MIME-Version`, `Content-Type`, `Content-Transfer-Encoding`, `X-SES-Configuration-Set`, or `X-SES-Message-Tags`.

AutoSend also reserves `List-Unsubscribe` and `List-Unsubscribe-Post`. Its docs do not say if it refuses these headers or drops them. mailswitch sends them unchanged, and the AutoSend answer decides the result. Do not trust these two headers to reach the recipient.

The AutoSend bulk endpoint shares one content for all recipients and takes no attachments. The mailer sends one request for each message. AutoSend has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.

### Delivery status

AutoSend errors have the shape `{ success: false, error: { message, code } }`. Some answers use the flat shape `{ success: false, message, code }`. mailswitch reads both.

| AutoSend answer | Status and reason |
|---|---|
| 2xx with `success: true` and `data.emailId` | `sent`. The message id is `data.emailId`. |
| 2xx with any other body | `unknown/provider_error` |
| 400 `VALIDATION_FAILED` | `not_sent/invalid_message` |
| 401 `UNAUTHORIZED` | `not_sent/auth` |
| 402 `PLAN_UPGRADE_REQUIRED` | `not_sent/credits` |
| 403 `INSUFFICIENT_PERMISSIONS` | `not_sent/auth` |
| 404 `NOT_FOUND` | `not_sent/rejected` |
| 429 `RATE_LIMIT_EXCEEDED` | `not_sent/rate_limited`, with `retryAfterMs` |
| Other 4xx | The default table. The body code can change only the reason. |
| 500 and every other 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

For a 429, mailswitch reads the `Retry-After` header first. When the header is missing, it reads `retryAfter` in the body as seconds. It caps the wait at one hour.

Every 5xx is `unknown`, because the AutoSend docs do not state that the message did not go out. A body code never changes `unknown` to `not_sent`. Do not retry and do not fall back after `unknown`.

## Webhooks

AutoSend signs each webhook request. Copy the webhook secret from AutoSend, for example into `AUTOSEND_WEBHOOK_SECRET`.

### Handle a webhook

The AutoSend adapter needs a dedupe store. The signature covers no timestamp, so the dedupe store is the only guard against a replay. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import type { DedupeStore } from "mailswitch";
import { autosend } from "mailswitch/autosend";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(request: Request, env: { AUTOSEND_WEBHOOK_SECRET: string }): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: autosend(),
      secret: env.AUTOSEND_WEBHOOK_SECRET,
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

mailswitch reads the `X-Webhook-Signature` header. It applies these rules:

- The header holds the hex HMAC-SHA256 of the raw body. The key is the webhook secret with the outer spaces removed, as UTF-8 text.
- mailswitch compares in constant time.
- A missing header, an empty secret, or a wrong signature gives `bad_signature`.
- A header that is not 64 hex characters gives `malformed`.
- A body that is not one JSON object gives `malformed`.

AutoSend also sends `X-Webhook-Timestamp`, `X-Webhook-Event`, and `X-Webhook-Delivery-Id`. The signature does not cover these headers, so mailswitch does not read them. The timestamp is not signed, so the check cannot refuse an old request as stale.

### Replays

The body has no event id. So mailswitch builds the event key from signed body fields: the event type, `data.emailId`, the recipient in lowercase, and `createdAt`. A request that comes again with a new `X-Webhook-Delivery-Id` gets the same key, and the dedupe store drops it.

The dedupe store keeps a key for 30 days by default. A request that someone captures and sends again after the TTL passes the check and gives its event again. Keep the webhook URL private, and rotate the secret in AutoSend if it leaks.

### Events

One request holds one event: `{ type, createdAt, data }`. Some AutoSend pages name the type field `event`. mailswitch reads `type` first, then `event`. A body with neither gives `unknown`.

| AutoSend event | Normalized event |
|---|---|
| `email.delivered` | `delivered` |
| `email.bounced` with `bounceType: Permanent` | `bounced`, `hard` |
| `email.bounced` with `bounceType: Transient` | `bounced`, `soft` |
| `email.bounced` with any other `bounceType` | `bounced`, with no class |
| `email.spam_reported` | `complained` |
| `email.unsubscribed` | `unsubscribed` |
| `email.group_unsubscribed`, `email.group_resubscribed` | `unknown`. These events are about one group, not all mail. |
| Any other event, for example `email.sent`, `email.deferred`, `email.opened`, or `contact.created` | `unknown` |

`rawType` is the AutoSend type. `providerMessageId` is `data.emailId`, which is the id in the send result. `recipient` is `data.to.email`. An `email.unsubscribed` body has no recipient, so `recipient` is not set. Use `providerMessageId` to find the address in your send records. `occurredAt` is `createdAt` in Unix milliseconds. When `data.emailId` or `createdAt` is missing, the event key is the SHA-256 of the raw body.

Read `bounceSubType`, `reason`, and `complaintType` in your own code when you need the details.

### Bounce detail

A `bounced` event carries `bounceDetail` when AutoSend sends these fields:

- `text`: `data.reason`.

The text comes from a remote mail server and can hold personal data. mailswitch does not escape markup in it. Escape the text before you show it.

## Live smoke test

The live smoke test runs only when these environment variables are set:

- `MAILSWITCH_LIVE_AUTOSEND_KEY`
- `MAILSWITCH_LIVE_AUTOSEND_FROM`
- `MAILSWITCH_LIVE_TO`

AutoSend has no sandbox, so the test sends one real email. Set `MAILSWITCH_LIVE_TO` to an address of the account owner. Use a project key.

## Links

- [Send an email](https://docs.autosend.com/api-reference/mails/send.md)
- [API keys](https://docs.autosend.com/api-keys.md)
- [Errors](https://docs.autosend.com/api-reference/errors.md)
- [Rate limits](https://docs.autosend.com/api-reference/rate-limit.md)
- [Webhook event types](https://docs.autosend.com/others/webhooks/event-type.md)
