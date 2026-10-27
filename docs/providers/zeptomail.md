# ZeptoMail

Last checked: 2026-10-27

The ZeptoMail adapter is in `mailswitch/zeptomail`. It is a tier 2 provider. It sends email with attachments and inline images, and it checks the Send Mail token. It does not read ZeptoMail webhooks.

In September 2026, Zoho renamed ZeptoMail to Zoho CPaaS. The existing tokens and the `api.zeptomail.*` hosts continue to work. mailswitch uses these hosts.

A new ZeptoMail account gets a free credit for the first 10,000 emails. The credit is valid for 6 months. After that, you buy credits. mailswitch sets no daily cap for ZeptoMail. Set a cap in the mailer if you need one.

## Set up the adapter

```ts
import { zeptomail } from "mailswitch/zeptomail";

declare const env: { ZEPTOMAIL_TOKEN: string };

const adapter = zeptomail({ token: env.ZEPTOMAIL_TOKEN, region: "eu" });
```

| Option | Use |
|---|---|
| `token` | The Send Mail token. The `token` credential takes precedence. |
| `region` | The region of the account. The `region` credential takes precedence, unless it has the default value. An unknown value throws a `TypeError`. |
| `fromAddress` | The sender of the verify request. The `fromAddress` credential takes precedence. |

The adapter has no `baseUrl` option. The `region` field selects one of the documented hosts.

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `token` | Yes | Yes | At least 8 characters with no space. The `Zoho-enczapikey ` prefix is optional. |
| `region` | No | No | One of the regions in the next table. The default is `com`. |
| `fromAddress` | No | No | An email address. Use an address of a verified domain. |

Get the token in the ZeptoMail app. Open **Mail Agents**, select the agent, and open **SMTP/API**. Copy the Send Mail token. The app shows the token with the `Zoho-enczapikey ` prefix. You can paste the token with or without the prefix. mailswitch removes a pasted prefix, and sends `Authorization: Zoho-enczapikey <token>` with one prefix.

| Region | Host |
|---|---|
| `com` | `https://api.zeptomail.com` |
| `eu` | `https://api.zeptomail.eu` |
| `in` | `https://api.zeptomail.in` |
| `com.au` | `https://api.zeptomail.com.au` |
| `jp` | `https://api.zeptomail.jp` |
| `ca` | `https://api.zeptomail.ca` |
| `sa` | `https://api.zeptomail.sa` |

The region is the domain ending of your account URL. For example, an account at `zeptomail.zoho.eu` uses `eu`. A token works only on the host of its region. A region that is not in the table gives `not_sent/auth`, with no request.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /v1.1/email` |
| `verify` | `POST /v1.1/email` with no recipient. See [Verify](#verify). |

The adapter has no `sendBatch`. ZeptoMail has no batch of different messages. The mailer sends a batch with one request for each message.

The request body:

- `from` and `reply_to` hold `{ address, name }` objects.
- `to`, `cc`, and `bcc` hold `{ email_address: { address, name } }` objects.
- `textbody` and `htmlbody` hold the bodies.
- Custom headers go to `mime_headers`.
- An attachment with no `contentId` goes to `attachments`, with `content`, `mime_type`, and `name`.
- An attachment with a `contentId` goes to `inline_images`, with the same fields and `cid`. Use `<img src="cid:logo">` for an attachment with `contentId: "logo"`.

Limits:

- An email can be at most 15 MB, with its attachments. mailswitch refuses a larger message as `not_sent/unsupported`, before any request.
- Each of `to`, `cc`, and `bcc` takes at most 500 addresses. mailswitch allows at most 500 addresses in total, across the three fields.
- ZeptoMail has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.
- ZeptoMail has no sandbox mode. Each send in a test delivers a real email.

### Delivery status

| ZeptoMail answer | Status and reason |
|---|---|
| 2xx with `data[0].code` `EM_104` | `sent`. The message id is `request_id`. |
| Any other 2xx, or a 2xx body that is not JSON | `unknown/provider_error` |
| 4xx with a known error code | `not_sent`, with the reason of the next table |
| 400, 413, 415, 422 with no known code | `not_sent/invalid_message` |
| 401, 403 with no known code | `not_sent/auth` |
| 402 with no known code | `not_sent/credits` |
| 429 | `not_sent/rate_limited`, with `retryAfterMs` from `Retry-After` |
| Other 4xx with no known code | `not_sent/rejected` |
| Any 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

ZeptoMail uses two error shapes. mailswitch reads the codes of both:

- `{ "error": { "code", "details": [{ "code", "message", "target" }], "message" } }`
- `{ "data": { "error_code", "message" }, "message": "error" }`

mailswitch uses the first code that it knows. It reads `error.code` first, then each `error.details[].code`, then `data.error_code`.

| Error code | Reason |
|---|---|
| `TM_4001`, `SERR_157`, `SERR_156`, `AE_101` | `auth` |
| `SMI_115`, `SM_133` | `quota` |
| `LE_101`, `LE_102` | `credits` |
| `SM_111`, `SM_113`, `SM_128` | `rejected` |
| `TM_8001`, `TM_3201` | `invalid_message` |

A result message holds the error code and the HTTP status. It never holds the error text of ZeptoMail.

ZeptoMail does not document a rate limit or a `Retry-After` header. A 429 uses the default table.

No ZeptoMail document states that a 5xx sent nothing. So every 5xx is `unknown`, as tier 2 requires. Do not retry and do not fall back after `unknown`. Because of this, a fallback to the next provider rarely occurs after a ZeptoMail failure. A fallback occurs only after a `not_sent` result, for example a bad token, no credits, or a refused message.

### Verify

ZeptoMail has no read call that checks a Send Mail token. So `verify` sends a request that cannot deliver email. The request has a `from` and a `subject`. It has no `to`, `cc`, or `bcc` field.

- The `from` is the `fromAddress` credential. When it is empty, the `from` is `verify@<region host>`, for example `verify@api.zeptomail.com`.
- ZeptoMail can check the sender before the recipients. If verify fails with a sender error, set `fromAddress` to an address of a verified domain.

Verify reads the answer with its own rule. It does not use the send table, where `TM_3201` is `invalid_message`.

| ZeptoMail answer | Verify result |
|---|---|
| 400 with `TM_3201` (a mandatory field is missing), in either error shape | `ok`. The token passed. |
| 401 with `TM_4001` | `not_sent/auth`. The token is wrong. |
| Other 4xx | `not_sent`, with the reason of the send table |
| Any 2xx | Not `ok`. `unknown/provider_error`, because ZeptoMail must refuse this request. |
| Any 5xx, a timeout, or a network error | `unknown` |

### Release gate

The 401 `TM_4001` answer to a wrong token was observed on 2026-10-27. The 400 `TM_3201` answer to a good token is not recorded yet. Before a release, run the live smoke test with a real token. The test must record both answers:

- A good token gets 400 `TM_3201`. Verify returns `ok`.
- A wrong token gets 401 `TM_4001`. Verify returns `not_sent/auth`.

Until both answers are recorded, verify stays as it is, and the release notes name the gap. There is no fallback to a check of the token format.

The live smoke test needs these env vars:

| Env var | Use |
|---|---|
| `MAILSWITCH_LIVE_ZEPTOMAIL_TOKEN` | A real Send Mail token. |
| `MAILSWITCH_LIVE_ZEPTOMAIL_FROM` | An address of a verified domain. It is the sender of verify and of the send. |
| `MAILSWITCH_LIVE_TO` | The recipient of the one real email. Use an address of the account owner. |
| `MAILSWITCH_LIVE_ZEPTOMAIL_REGION` | Optional. The region. The default is `com`. |

```sh
corepack pnpm exec vitest run test/live/smoke.test.ts
```

## Webhooks

The adapter does not read ZeptoMail webhooks. Webhooks for tier 2 providers come in a later release. `meta.webhooks` is `false`.

## Links

- [Email sending API](https://www.zoho.com/zeptomail/help/api/email-sending.html)
- [Error codes](https://www.zoho.com/zeptomail/help/api/error-codes.html)
- [Pricing](https://www.zoho.com/zeptomail/pricing.html)
- [ZeptoMail is now Zoho CPaaS](https://www.zoho.com/blog/cpaas/zeptomail-is-now-zoho-cpaas.html)
