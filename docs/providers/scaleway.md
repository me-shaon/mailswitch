# Scaleway Transactional Email

Last checked: 2026-10-27

The Scaleway Transactional Email adapter is in `mailswitch/scaleway`. It is a tier 2 provider. It sends email with attachments, and it checks the secret key. It does not read Scaleway webhooks.

The Scaleway Transactional Email API is at version `v1alpha1`. An alpha API can change. The fixtures of mailswitch pin the fields that the adapter uses. Run the live smoke test after a Scaleway change.

The free tier of Scaleway Transactional Email includes 300 emails each month. mailswitch sets no daily cap for Scaleway. Set a cap in the mailer if you need one.

## Set up the adapter

```ts
import { scaleway } from "mailswitch/scaleway";

declare const env: { SCW_SECRET_KEY: string; SCW_PROJECT_ID: string };

const adapter = scaleway({ secretKey: env.SCW_SECRET_KEY, projectId: env.SCW_PROJECT_ID });
```

| Option | Use |
|---|---|
| `secretKey` | The secret key of an IAM API key. The `secretKey` credential takes precedence. |
| `projectId` | The ID of the Project that holds the checked domain. The `projectId` credential takes precedence. |
| `baseUrl` | The API origin. The default is `https://api.scaleway.com`. Tests and proxies change it. It must be an https URL. |

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `secretKey` | Yes | Yes | 8 to 64 letters, digits, or hyphens. Scaleway gives a UUID. |
| `projectId` | No | Yes | 8 to 64 letters, digits, or hyphens. Scaleway gives a UUID. |

Make an IAM API key in the Scaleway console. Give its application or user a policy with Transactional Email access in the Project. Copy the secret key. Scaleway shows the secret key only once. The adapter sends it in the `X-Auth-Token` header.

The Project ID is on the settings page of the Project. A send with an empty Project ID gives `not_sent/auth`, with no request. So does a verify.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /transactional-email/v1alpha1/regions/fr-par/emails` |
| `verify` | `GET /transactional-email/v1alpha1/regions/fr-par/domains?project_id=<id>&page_size=1` |

Scaleway Transactional Email is only in the `fr-par` region. The adapter has no region option.

The adapter has no `sendBatch`. Scaleway has no batch endpoint. The mailer sends a batch with one request for each message.

The request body:

- `from`, `to`, `cc`, and `bcc` hold `{ email, name }` objects.
- `text` and `html` hold the bodies.
- `project_id` holds the Project ID.
- An attachment goes to `attachments`, with `name`, `type`, and the base64 `content`.
- Reply-To goes to `additional_headers` as `{ "key": "Reply-To", "value": "<mailbox>" }`. A display name with non-ASCII text becomes RFC 2047 encoded words.
- Each custom header goes to `additional_headers` as `{ key, value }`, after Reply-To. The value goes unchanged.

Limits:

- An email can be at most 2 MB, with its attachments. Scaleway does not raise this limit. mailswitch uses 2,000,000 bytes after base64 encoding. It refuses a larger message as `not_sent/unsupported`, before any request.
- An email can have at most 10 recipients, across `to`, `cc`, and `bcc`. mailswitch refuses 11 or more as `not_sent/unsupported`, before any request.
- An email can have at most 10 attachments. mailswitch refuses 11 or more as `not_sent/unsupported`, before any request.
- Scaleway has no inline attachments. mailswitch refuses an attachment with a `contentId` as `not_sent/unsupported`, before any request.
- Scaleway allows only some attachment MIME types. mailswitch does not check the type. Scaleway refuses a type that it does not allow, and the result is `not_sent`.
- Scaleway has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.
- Scaleway has no sandbox mode. Each send in a test delivers a real email.

### Delivery status

| Scaleway answer | Status and reason |
|---|---|
| 2xx with an `emails[]` entry whose status is `new`, `sending`, or `sent` and whose `id` is not blank | `sent`. The message id is the `id` of the first such entry. |
| 2xx with no such entry, for example when every entry is `failed` or `canceled` | `unknown/provider_error` |
| Any other 2xx, or a 2xx body that is not JSON | `unknown/provider_error` |
| 4xx with a known error `type` | `not_sent`, with the reason of the next table |
| 400, 413, 415, 422 with no known `type` | `not_sent/invalid_message` |
| 401, 403 with no known `type` | `not_sent/auth` |
| 402 with no known `type` | `not_sent/credits` |
| 429 | `not_sent/rate_limited`, with `retryAfterMs` from `Retry-After` |
| Other 4xx with no known `type` | `not_sent/rejected` |
| Any 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

Scaleway answers one entry in `emails[]` for each recipient. All the entries belong to one message, so the adapter uses the id of the first entry.

A Scaleway error body has the shape `{ "type", "message", "details" }`. mailswitch reads only `type`.

| Error `type` | Reason |
|---|---|
| `invalid_arguments` | `invalid_message` |
| `quotas_exceeded` | `quota` |
| `permissions_denied`, `denied_authentication` | `auth` |

Any other `type` keeps the reason of its HTTP status. The `type` changes only the reason of a `not_sent` result. It never changes `unknown` to `not_sent`. A result message holds the HTTP status and the `type`. It never holds the error text of Scaleway.

The OpenAPI spec of Scaleway documents only the 200 answer. The general API page documents 400 for a missing parameter, 401 for a key that is not valid, and 5xx for a server error. The error types come from the official Scaleway SDKs. Scaleway does not document a rate limit or a `Retry-After` header. A 429 uses the default table.

No Scaleway document states that a 5xx sent nothing. So every 5xx is `unknown`, as tier 2 requires. Do not retry and do not fall back after `unknown`. Because of this, a fallback to the next provider rarely occurs after a Scaleway failure. A fallback occurs only after a `not_sent` result, for example a bad key, a quota limit, or a refused message.

### Verify

Verify lists the domains of the Project, with one domain per page. This call is an authenticated read. It sends no email. An empty list is `ok`.

| Scaleway answer | Verify result |
|---|---|
| 2xx | `ok` |
| 401 or 403 | `not_sent/auth` |
| Other 4xx | `not_sent`, with the reason of the send table |
| Any 5xx, a timeout, or a network error | `unknown` |

The live smoke test runs verify, then sends one real email. It needs these env vars:

| Env var | Use |
|---|---|
| `MAILSWITCH_LIVE_SCALEWAY_SECRET_KEY` | A real secret key. |
| `MAILSWITCH_LIVE_SCALEWAY_PROJECT_ID` | The ID of the Project. |
| `MAILSWITCH_LIVE_SCALEWAY_FROM` | An address of a checked domain of the Project. |
| `MAILSWITCH_LIVE_TO` | The recipient of the one real email. Use an address of the account owner. |

```sh
corepack pnpm exec vitest run test/live/smoke.test.ts
```

## Webhooks

The adapter does not read Scaleway webhooks. Scaleway sends webhook events through Topics and Events, which uses SNS-style signatures. A check of those signatures needs an X.509 certificate chain. This support comes in a later release. `meta.webhooks` is `false`.

## Links

- [Transactional Email API](https://www.scaleway.com/en/developers/api/transactional-email/)
- [OpenAPI spec (v1alpha1)](https://www.scaleway.com/en/developers/api/transactional-email/v1alpha1/schema.yml)
- [Capabilities and limits](https://www.scaleway.com/en/docs/transactional-email/reference-content/tem-capabilities-and-limits/)
- [Scaleway API errors](https://www.scaleway.com/en/developers/api/)
