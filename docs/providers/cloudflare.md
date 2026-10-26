# Cloudflare Email

Last checked: 2026-10-26

mailswitch sends email through Cloudflare Email Sending with one of two transports. Both transports are in the `mailswitch/cloudflare` subpath.

| Transport | Function | Catalog id | Credentials |
|---|---|---|---|
| REST API | `cloudflareRest()` | `cloudflare-rest` | `accountId`, `apiToken` |
| Workers binding | `cloudflareBinding()` | `cloudflare-binding` | `bindingName` |

Both transports are tier 1. Cloudflare Email Sending is for transactional email only. Do not send campaigns through it.

## Choose a transport

Use the binding transport in a Worker that has a `send_email` binding. It needs no API token.

Use the REST transport when the code does not run in a Worker, or when the Worker has no binding. The REST transport uses `fetch`, so it works on any runtime.

## Set up the sending domain

1. Onboard the sending domain in the Cloudflare dashboard, under Email Service.
2. Send from an address on that domain.

Cloudflare refuses a sender on a domain that is not onboarded.

## REST transport

1. Find the account ID on the Overview page of the Cloudflare dashboard.
2. Make an API token with the Email Sending permission for the account.
3. Keep the token in a Worker secret. Do not put it in the source code.

```ts
import { createMailer } from "mailswitch";
import { cloudflareRest } from "mailswitch/cloudflare";

const mailer = createMailer({
  provider: cloudflareRest({ accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_EMAIL_TOKEN }),
});
```

The credentials in `SendContext` take precedence over the options. A mailer that parses stored credentials can call `cloudflareRest()` with no options.

### Batches

The REST API has no batch endpoint. `sendBatch` sends up to 25 messages. It sends one request per message, with 5 requests at a time. After an `auth`, `rate_limited`, or `quota` result, the messages that did not start get the same `not_sent` result. They make no request.

### Verify

`verify` calls the token verify endpoint. It sends no email. It tries the account path first, then the user path. A token that is not active gives `not_sent/auth`.

## Binding transport

1. Add a `send_email` binding to the Wrangler configuration:

   ```jsonc
   { "send_email": [{ "name": "EMAIL" }] }
   ```

2. Pass the binding to `cloudflareBinding`:

   ```ts
   import { createMailer } from "mailswitch";
   import { cloudflareBinding } from "mailswitch/cloudflare";

   const mailer = createMailer({ provider: cloudflareBinding(env.EMAIL) });
   ```

3. Or pass the Worker `env`. The adapter then reads the binding that the `bindingName` credential names. The default name is `EMAIL`.

   ```ts
   const provider = cloudflareBinding({ env });
   ```

The binding transport sends the structured message of the binding. It does not build raw MIME. mailswitch does not import `cloudflare:email`. The binding has a local type, `CloudflareSendEmail`, and the `SendEmail` type of `@cloudflare/workers-types` fits it.

The binding has no read call. So `verify` checks only that the binding is present. A missing binding gives `not_sent/auth`.

## Message IDs

| Transport | Message ID |
|---|---|
| REST API | `result.message_id`, when the response has it. The API reference lists this field. The examples on the REST guide page do not show it. When it is missing, the result has no `providerMessageId`. |
| Workers binding | `messageId` from the binding. |

## Limits

| Limit | Value |
|---|---|
| Message size | 5 MiB, with attachments. |
| Recipients | 50 across `to`, `cc`, and `bcc`. |

mailswitch refuses a message over these limits as `not_sent/unsupported`. It makes no call to Cloudflare.

## Delivery status

### REST API

The default status table applies. The adapter reads the Cloudflare error code to refine a `not_sent` reason.

| HTTP | Code | Result |
|---|---|---|
| 400 | 10001, 10200, 10201, 10202 | `not_sent/invalid_message` |
| 401 | 10101, 10103 | `not_sent/auth` |
| 403 | 10102, 10105, 10203, 10207 | `not_sent/auth` |
| 404 | 10000 | `not_sent/auth` (the account does not exist for the token) |
| 429 | 10004 | `not_sent/rate_limited` |
| 5xx | any | `unknown` |

Every 5xx stays `unknown`. This includes 503 with code 10100. The status map works on the HTTP status only, and another 503 can come after Cloudflare accepted the message.

A 2xx response lists each recipient as delivered, queued, bounced, or suppressed. When every recipient bounced or was suppressed, the result is `not_sent/rejected`.

### Workers binding

The binding throws an error with a `code` property. Only a code that proves that Cloudflare did not accept the message gives `not_sent`.

| Code | Result |
|---|---|
| `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_RECIPIENTS`, `E_TOO_MANY_ATTACHMENTS`, `E_CONTENT_TOO_LARGE` | `not_sent/invalid_message` |
| `E_HEADER_NOT_ALLOWED`, `E_HEADER_USE_API_FIELD`, `E_HEADER_VALUE_INVALID`, `E_HEADER_VALUE_TOO_LONG`, `E_HEADER_NAME_INVALID`, `E_HEADERS_TOO_LARGE`, `E_HEADERS_TOO_MANY` | `not_sent/invalid_message` |
| `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_RECIPIENT_NOT_ALLOWED`, `E_RECIPIENT_SUPPRESSED` | `not_sent/rejected` |
| `E_ACCOUNT_SUSPENDED` | `not_sent/auth` |
| `E_RATE_LIMIT_EXCEEDED` | `not_sent/rate_limited` |
| `E_DAILY_LIMIT_EXCEEDED` | `not_sent/quota` |
| `E_DELIVERY_FAILED`, `E_INTERNAL_SERVER_ERROR`, any other code | `unknown/provider_error` |
| An error with no code | `unknown` |

A binding that does not answer within `timeoutMs` gives `unknown/timeout`.

## Custom headers

Cloudflare accepts only the headers on its allowlist. A header outside the list gives `not_sent/invalid_message`. Set `From`, `To`, `Subject`, and `Reply-To` with the message fields, not with headers.

## Webhooks

Cloudflare sends delivery events to a Queue, not to a webhook. Neither transport has webhooks. `handleWebhook` throws a `TypeError` for a Cloudflare adapter.

## Known gaps

- The REST guide shows `reply_to` only as a plain address. mailswitch sends the address and drops the display name.
- The REST guide does not show the field for the content id of an inline attachment. mailswitch sends `content_id`.

## Sources

- REST API: https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
- REST API reference: https://developers.cloudflare.com/api/resources/email_sending/methods/send/
- Workers API: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- Recipients: https://developers.cloudflare.com/email-service/examples/email-sending/recipients/
