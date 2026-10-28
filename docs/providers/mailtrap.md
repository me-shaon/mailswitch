# Mailtrap

Last checked: 2026-10-27

The Mailtrap adapter is in `mailswitch/mailtrap`. It is a tier 1 provider. It sends email with attachments through the Mailtrap Email API, checks the API token, and reads signed Mailtrap webhook requests.

The Mailtrap free plan sends at most 150 emails each day and 4,000 emails each month. Mailtrap refuses a send over the cap. mailswitch sets no daily cap for Mailtrap. Set a cap in the mailer if your plan has one.

## Set up the adapter

```ts
import { mailtrap } from "mailswitch/mailtrap";

declare const env: { MAILTRAP_API_TOKEN: string };

const adapter = mailtrap({ apiKey: env.MAILTRAP_API_TOKEN });
```

| Option | Use |
|---|---|
| `apiKey` | The API token. The `apiKey` credential takes precedence. |
| `stream` | The sending stream: `"transactional"` (the default) or `"bulk"`. Any other value throws a `TypeError`. |
| `sandboxInboxId` | The id of a sandbox inbox, as a string of digits. When it is set, every send goes to that inbox, and Mailtrap delivers no email. It cannot be used with `stream: "bulk"`. |
| `baseUrl` | The send origin, for tests or a proxy. It replaces the stream or sandbox origin. It must be an https URL. Plain http works only for a loopback host, for tests. |
| `accountsUrl` | The origin of the account API that `verify` calls. The default is `https://mailtrap.io`. `baseUrl` does not change it. |

Each stream and the sandbox has its own host:

| Mode | Send URL |
|---|---|
| Transactional | `https://send.api.mailtrap.io/api/send` |
| Bulk | `https://bulk.api.mailtrap.io/api/send` |
| Sandbox | `https://sandbox.api.mailtrap.io/api/send/{inbox_id}` |

Use the sandbox for tests:

```ts
import { mailtrap } from "mailswitch/mailtrap";

const adapter = mailtrap({ sandboxInboxId: "123456" });
```

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | An API token. Mailtrap documents no format. The pattern accepts 16 to 512 letters, digits, dots, underscores, and hyphens. |

Make the token on the API Tokens page of the Mailtrap settings. Give it access to the sending domain. For the sandbox, give it access to the inbox. mailswitch sends the token in the `Api-Token` header.

`verify` reads `GET https://mailtrap.io/api/accounts`. A token with access to only a domain may not be able to read the account list. If a token that can send fails `verify` with a 401 or a 403, give the token read access to the account. mailswitch gives a 401 and a 403 as `not_sent/auth`.

Every request sends the `User-Agent: mailswitch` header, because the Mailtrap edge blocks a request with no `User-Agent`.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /api/send` on the stream host, or `POST /api/send/{inbox_id}` on the sandbox host |
| `verify` | `GET https://mailtrap.io/api/accounts`. It sends no email. |

mailswitch sends each address as `{ email, name }`. Each attachment goes out as base64 with its `filename` and `type`. An attachment with a `contentId` goes out with `disposition: "inline"` and `content_id`. Every other attachment goes out with `disposition: "attachment"`. Custom headers go out unchanged in `headers`.

Limits:

- A message can be at most 10 MB, with its attachments. mailswitch checks the message after encoding against 10 MB.
- To, Cc, and Bcc can each hold at most 1000 addresses. mailswitch caps the sum of the three lists at 1000 and refuses a larger message as `not_sent/unsupported` before any request.
- Mailtrap allows 150 requests each 10 seconds for each token.
- The Mailtrap batch endpoint mainly sets recipients, and the docs do not say that each entry can carry its own content. The mailer sends one request for each message.
- Mailtrap has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.

### Delivery status

| Mailtrap answer | Status and reason |
|---|---|
| 2xx with `success: true` and a `message_ids` list | `sent`. The message id is the first entry of `message_ids`. |
| 2xx with any other body | `unknown/provider_error` |
| 400 | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| 429 | `not_sent/rate_limited`. Mailtrap documents no `Retry-After` header. When one is present, mailswitch copies it into `retryAfterMs`. |
| Other 4xx | `not_sent/rejected` |
| 500 and every other 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

Every 5xx is `unknown`, because the Mailtrap docs do not state that the message did not go out. Do not retry and do not fall back after `unknown`.

## Webhooks

Mailtrap signs each webhook request. Copy the signing secret of the webhook from Mailtrap, for example into `MAILTRAP_WEBHOOK_SECRET`. Set the payload format of the webhook to JSON. mailswitch does not read the JSON Lines format.

### Handle a webhook

The Mailtrap adapter needs a dedupe store. The signature covers no timestamp, so the dedupe store is the only guard against a replay. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import type { DedupeStore } from "mailswitch";
import { mailtrap } from "mailswitch/mailtrap";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(request: Request, env: { MAILTRAP_WEBHOOK_SECRET: string }): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: mailtrap(),
      secret: env.MAILTRAP_WEBHOOK_SECRET,
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

mailswitch reads the `Mailtrap-Signature` header. It applies these rules:

- The header holds the lowercase hex HMAC-SHA256 of the raw body. The key is the signing secret of the webhook, as UTF-8 text.
- mailswitch compares in constant time.
- A missing header, an empty secret, or a wrong signature gives `bad_signature`.
- A header that is not 64 hex characters gives `malformed`.
- A body that is not one JSON object with an `events` list gives `malformed`.

The signature covers no timestamp. So the check cannot refuse an old request as stale. The dedupe store drops a repeat of an event inside its TTL, which is 30 days by default. A request that someone captures and sends again after the TTL passes the check and gives its events again. Keep the webhook URL private, and rotate the secret in Mailtrap if it leaks.

### Events

One request holds up to 500 events in `{"events": [...]}`. Each entry gives one event.

| Mailtrap event | Normalized event |
|---|---|
| `delivery` | `delivered` |
| `bounce` | `bounced`, `hard` |
| `soft bounce` | `bounced`, `soft` |
| `spam` | `complained` |
| `unsubscribe` | `unsubscribed` |
| Any other event, for example `reject`, `suspension`, `open`, or `click` | `unknown` |

`rawType` is the Mailtrap `event` value. The event key is `event_id`, which the signature covers. `providerMessageId` is `message_id`, which is the id in the send result. `recipient` is `email`. `occurredAt` is the Unix `timestamp` in milliseconds. An entry with no `event_id` gets the SHA-256 of the raw body and the entry index as its key. An entry that is not an object is skipped.

Read `bounce_category`, `response`, and `response_code` in your own code when you need the bounce details.

### Bounce detail

A `bounced` event carries `bounceDetail` when Mailtrap sends these fields:

- `text`: `response`.
- `smtpCode`: `response_code`.

The text comes from a remote mail server and can hold personal data. mailswitch does not escape markup in it. Escape the text before you show it.

## Live smoke test

The live smoke test runs only when these environment variables are set:

- `MAILSWITCH_LIVE_MAILTRAP_TOKEN`
- `MAILSWITCH_LIVE_MAILTRAP_FROM`
- `MAILSWITCH_LIVE_TO`

When `MAILSWITCH_LIVE_MAILTRAP_SANDBOX_ID` is also set, the test sends to that sandbox inbox, and Mailtrap delivers no email. Without it, the test sends one real email. Set `MAILSWITCH_LIVE_TO` to an address of the account owner.

## Links

- [Send a transactional email](https://docs.mailtrap.io/developers/email-sending/transactional/send-transactional-email.md)
- [Authentication](https://docs.mailtrap.io/developers/authentication.md)
- [Sending limits](https://docs.mailtrap.io/email-api-smtp/setup/sending-limits.md)
- [Webhooks](https://docs.mailtrap.io/email-api-smtp/advanced/webhooks.md)
