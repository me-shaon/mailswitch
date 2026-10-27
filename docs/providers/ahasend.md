# AhaSend

Last checked: 2026-10-27

The AhaSend adapter is in `mailswitch/ahasend`. It is a tier 1 provider. It sends email with attachments through the AhaSend API v2, uses the AhaSend idempotency key, checks the API key, and reads signed AhaSend webhook requests.

## Set up the adapter

```ts
import { ahasend } from "mailswitch/ahasend";

declare const env: { AHASEND_API_KEY: string; AHASEND_ACCOUNT_ID: string };

const adapter = ahasend({ apiKey: env.AHASEND_API_KEY, accountId: env.AHASEND_ACCOUNT_ID });
```

| Option | Use |
|---|---|
| `apiKey` | The API key. The `apiKey` credential takes precedence. |
| `accountId` | The account ID. The `accountId` credential takes precedence. |
| `baseUrl` | The API origin. The default is `https://api.ahasend.com`. It must be an https URL. Plain http works only for a loopback host, for tests. |
| `sandbox` | Set `true` to send with `sandbox: true`. AhaSend checks the request and delivers no email. Use it only for tests. |

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | `aha-sk-`, then at least 20 characters with no space. |
| `accountId` | No | Yes | The account ID, a UUID. The pattern accepts 8 to 64 letters, digits, and hyphens. |

Make the key in the AhaSend dashboard. Give it permission to send from your domain. mailswitch sends it in the `Authorization: Bearer` header.

Do not give the key an IP allowlist. A Cloudflare Worker has no fixed outbound IP address, so AhaSend refuses the key with 403, and mailswitch gives `not_sent/auth`.

The AhaSend free plan sends 1,000 emails each month.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /v2/accounts/{account_id}/messages/conversation`. This endpoint takes cc and bcc, and it does no template rendering. |
| `verify` | `GET /v2/ping`. It sends no email. A good key gets 200 with `{"message":"pong"}`. |

mailswitch sends the text body as `text_content` and the HTML body as `html_content`. Each attachment goes out as base64 with `base64: true`. An attachment with a `contentId` goes out with `content_id` in angle brackets and `content_disposition: "inline"`.

Limits:

- To, Cc, and Bcc can each hold at most 50 addresses. mailswitch refuses a larger list as `not_sent/invalid_message` before any request.
- AhaSend ignores a custom `Message-ID` header. mailswitch refuses it as `not_sent/invalid_message` before any request, so the header is never dropped without notice.
- The AhaSend docs state no message size limit. mailswitch uses 10 MB after encoding until a live test confirms the real limit.
- AhaSend has no batch endpoint for distinct messages. The mailer sends one request for each message.

### Idempotency

mailswitch sends the message key in the `Idempotency-Key` header. A key that is printable ASCII and at most 255 characters goes out as it is. Any other key goes out as the SHA-256 hex of its UTF-8 bytes. A retry with the same key sends the same bytes.

AhaSend keeps a key for 24 hours. A repeat of a completed request gets the first answer again, with the `Idempotent-Replayed: true` header. AhaSend does not store a 5xx, a 429, or an auth failure, so a retry of those sends again.

The window is shorter than 7 days. So `createMailer` logs a warning when the mailer has no idempotency store. Add a store to keep duplicate protection after 24 hours.

### Delivery status

| AhaSend answer | Status and reason |
|---|---|
| 202 with a `data` entry that has `status` `queued` or `scheduled` | `sent`. The message id is the `id` of the first such entry. |
| 202 where every entry has `status: "error"`, with one entry for each to, cc, and bcc recipient | `not_sent/rejected` |
| 202 with any other shape: an empty `data` list, fewer or more entries than recipients, an unknown status, or a body that mailswitch cannot read | `unknown/provider_error` |
| 400 | `not_sent/invalid_message` |
| 401 (a wrong key, or paused sending), 403 (the key cannot send from the domain) | `not_sent/auth` |
| 404 | `not_sent/rejected` |
| 409 (a request with the same key is in progress) | `unknown/idempotency_conflict` |
| 422 (the key was used with another method, path, or body) | `unknown/idempotency_conflict` |
| 429 | `not_sent/rate_limited`, with `retryAfterMs` from `Retry-After` |
| 500, 503, and every other 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

The 409 and the 422 are `unknown` because the earlier request with the key may have sent. Every 5xx is `unknown`, because the AhaSend docs do not state that the message did not go out. Do not retry and do not fall back after `unknown`.

## Webhooks

AhaSend signs each webhook request with Standard Webhooks headers. The webhook secret starts with `aha-whsec-`. Store the whole secret, with its prefix, for example in `AHASEND_WEBHOOK_SECRET`.

### Handle a webhook

The AhaSend adapter needs a dedupe store. AhaSend can deliver an event again, and the dedupe store drops the second copy. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import type { DedupeStore } from "mailswitch";
import { ahasend } from "mailswitch/ahasend";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(request: Request, env: { AHASEND_WEBHOOK_SECRET: string }): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: ahasend(),
      secret: env.AHASEND_WEBHOOK_SECRET,
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

mailswitch reads the `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers. It applies these rules:

- The signed content is the `webhook-id` value, a dot, the `webhook-timestamp` value, a dot, and the raw body.
- The HMAC-SHA256 key is the literal UTF-8 bytes of the secret, with the `aha-whsec-` prefix. mailswitch does not decode the secret from base64.
- `webhook-signature` holds `v1,<base64>` entries separated by spaces. The request passes when any entry matches. mailswitch compares in constant time.
- A timestamp more than 5 minutes in the past or in the future gives `stale`. AhaSend recommends this window.
- A missing header, an empty secret, or a wrong signature gives `bad_signature`.
- A timestamp that is not an integer, or a body that is not one JSON object, gives `malformed`.

### Events

One request holds one event: `{ type, webhook_id, timestamp, data }`.

| AhaSend event | Normalized event |
|---|---|
| `message.delivered` | `delivered` |
| `message.bounced` | `bounced`, with no bounce class |
| `message.transient_error` | `bounced`, `soft` |
| `message.complained` | `complained` |
| Any other event, for example `message.failed`, `message.opened`, or `suppression.created` | `unknown` |

`rawType` is the AhaSend `type` value. The event key is the `webhook-id` header, which the signature covers. `providerMessageId` is `data.id`, which is the id in the send result. `recipient` is `data.recipient`. `occurredAt` is the body `timestamp` in milliseconds.

`message.bounced` has no bounce class, because the AhaSend docs do not say if it is always permanent. Read `data.delivery_attempt` in your own code when you need the SMTP code.

## Live smoke test

The live smoke test sends with `sandbox: true`, so AhaSend delivers no email. It runs only when these environment variables are set:

- `MAILSWITCH_LIVE_AHASEND_KEY`
- `MAILSWITCH_LIVE_AHASEND_ACCOUNT_ID`
- `MAILSWITCH_LIVE_AHASEND_FROM`
- `MAILSWITCH_LIVE_TO`

## Links

- [Create a conversation message](https://ahasend.com/docs/api-reference/messages/create-conversation.md)
- [Authentication](https://ahasend.com/docs/api-reference/authentication.md)
- [Errors](https://ahasend.com/docs/api-reference/errors.md)
- [Idempotency](https://ahasend.com/docs/api-reference/idempotency.md)
- [Ping](https://ahasend.com/docs/api-reference/utility/ping.md)
- [Webhook security](https://ahasend.com/docs/api-reference/webhooks/security.md)
- [Webhooks](https://ahasend.com/docs/integrations/webhooks.md)
