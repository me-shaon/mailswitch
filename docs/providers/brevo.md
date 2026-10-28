# Brevo

Last checked: 2026-10-27

The Brevo adapter is in `mailswitch/brevo`. It is a tier 1 provider. It sends email with attachments through the Brevo API, checks the API key, and reads Brevo webhook requests. It sends an idempotency key to Brevo.

To send through the Brevo SMTP relay instead, use the `brevo` preset of the [SMTP adapter](smtp.md).

The free Brevo plan sends 300 emails a day. mailswitch sets no daily cap for Brevo. Set the cap of your plan in the mailer.

## Set up the adapter

```ts
import { brevo } from "mailswitch/brevo";

declare const env: { BREVO_API_KEY: string };

const adapter = brevo({ apiKey: env.BREVO_API_KEY });
```

| Option | Use |
|---|---|
| `apiKey` | The API key. The `apiKey` credential takes precedence. |
| `baseUrl` | The API origin. The default is `https://api.brevo.com`. It must be an https URL. Plain http works only for a loopback host, for tests. |
| `sandbox` | Set `true` to send the `X-Sib-Sandbox: drop` header. Brevo checks the request and answers 201, but it sends no email. Use it only for tests. |

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | A v3 API key that starts with `xkeysib-`. |

Make the key in Brevo, under **SMTP & API**, then **API Keys**. Do not use the SMTP key. The SMTP key is for the SMTP relay only.

### Authorized IPs

Brevo can limit an API key to a list of IP addresses. A Worker has no fixed outbound IP address. With the list on, Brevo refuses the calls of the Worker, and the result looks like a wrong key (`not_sent/auth`).

Turn off **Authorized IPs** for the key that the Worker uses. This is a known trade-off: a stolen key then works from any address. To lower the risk:

- Keep the key in a Worker secret. Do not put it in source control.
- Use a separate key for each app.
- Rotate the key on a schedule, and at once when you think it leaked.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /v3/smtp/email` |
| `verify` | `GET /v3/account`. It sends no email. |

The request has the `api-key` header. Brevo writes custom header names in Title-Case, so `x-invoice` arrives as `X-Invoice`.

Limits:

- A message can have at most 99 recipients in To, Cc, and Bcc.
- A message can be at most 20 MB after encoding.
- Brevo has no inline attachments. mailswitch refuses an attachment with a `contentId` as `not_sent/unsupported` before any request.
- The mailer sends one request for each message. A Brevo `messageVersions` batch shares the sender and the attachments, so mailswitch does not use it.

### Idempotency

Brevo takes an idempotency key as a UUID in the `headers` object of the body. mailswitch makes the UUID from `idempotencyKey`. It hashes the key with SHA-256 and formats the first 16 bytes as a version 8 UUID. The same key always gives the same UUID, so a retry sends the same bytes.

The adapter owns two body header names: `idempotencyKey` and `X-Sib-Sandbox`. A message with a custom header of one of these names, in any case, gets `not_sent/invalid_message` before any request.

Brevo keeps a key for 30 minutes. The mailswitch idempotency store keeps a sent record for 7 days. Set an idempotency store in the mailer. Without one, `createMailer` logs a warning, because a keyed retry after 30 minutes can send a second email.

### Delivery status

| Brevo answer | Status and reason |
|---|---|
| 201 with `messageId` | `sent`. The message id is `messageId`. |
| 2xx with no message id that mailswitch can read | `unknown/provider_error` |
| 400 with `duplicate_parameter` or `duplicate_request`, on a send with a key | `unknown/idempotency_conflict` |
| 400 with `duplicate_parameter` or `duplicate_request`, on a send without a key | `not_sent/invalid_message` |
| 400 with `not_enough_credits` | `not_sent/credits` |
| 400 with `unauthorized`, `permission_denied`, or `account_under_validation` | `not_sent/auth` |
| 400 with no error code that mailswitch can read, on a send with a key | `unknown/provider_error` |
| Any other 400 | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| 402 | `not_sent/credits` |
| 429 | `not_sent/rate_limited` |
| 500 and every other 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

A key in use means that the earlier request with that key may have sent. So the result is `unknown`. Do not retry and do not fall back after `unknown`.

A 429 from Brevo has the `x-sib-ratelimit-reset` header. It holds the seconds until the limit resets. mailswitch copies it into `retryAfterMs` when there is no `Retry-After` header.

Brevo does not document a 5xx. So every 5xx is `unknown`.

## Webhooks

The Brevo adapter uses the same webhook code as the `mailswitch/smtp/brevo` subpath. `mailswitch/brevo` exports `brevoWebhooks`, `generateBrevoWebhookToken`, `BREVO_WEBHOOK_EVENTS`, and the other names of that subpath. The adapter has its own webhook methods, and its events carry the provider id `brevo`.

Brevo signs nothing. It sends a bearer token that you set on the webhook. mailswitch uses the token as the webhook secret. To make the token and to set up the webhook in Brevo, follow [Brevo webhooks](smtp.md#brevo-webhooks) in the SMTP guide. The token rules, the events, and the event keys are the same.

### Handle a webhook

The Brevo adapter needs a dedupe store. The token covers no timestamp and no body, so a replayed request passes the check. The dedupe store is the only replay guard. `handleWebhook` requires the store in its types, and it throws when the store is missing. Use HTTPS for the webhook URL.

```ts
import type { DedupeStore } from "mailswitch";
import { brevo } from "mailswitch/brevo";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(request: Request, env: { BREVO_WEBHOOK_TOKEN: string }): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: brevo(),
      secret: env.BREVO_WEBHOOK_TOKEN,
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

### Bounce detail

A `bounced` event carries `bounceDetail` when Brevo sends these fields:

- `text`: `reason`.

The text comes from a remote mail server and can hold personal data. mailswitch does not escape markup in it. Escape the text before you show it.

## Links

- [Send a transactional email](https://developers.brevo.com/reference/sendtransacemail)
- [Get your account information](https://developers.brevo.com/reference/getaccount)
- [Status codes and error codes](https://developers.brevo.com/docs/how-it-works)
- [Rate limit headers](https://developers.brevo.com/docs/limit-headers)
- [Idempotency key](https://developers.brevo.com/docs/heterogenous-versions-batch-emails)
- [Sandbox mode](https://developers.brevo.com/docs/using-sandbox-mode)
- [Brevo transactional webhooks](https://developers.brevo.com/docs/transactional-webhooks)
- [Brevo free plan limits](https://help.brevo.com/hc/en-us/articles/208580669)
