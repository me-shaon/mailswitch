# Mailgun

Last checked: 2026-10-26

The Mailgun adapter sends email with the Mailgun HTTP API. It is a tier 1 provider. Import it from `mailswitch/mailgun`.

## Send email

```ts
import { createMailer } from "mailswitch";
import { mailgun } from "mailswitch/mailgun";

declare const env: { MAILGUN_API_KEY: string };

const mailer = createMailer({
  providers: [
    {
      adapter: mailgun(),
      credentials: { apiKey: env.MAILGUN_API_KEY, domain: "mg.example.com", region: "eu" },
    },
  ],
});
```

### Options

| Option | Use |
|---|---|
| `apiKey` | The Mailgun API key. The `apiKey` credential takes precedence. |
| `domain` | The sending domain, for example `mg.example.com`. The `domain` credential takes precedence. |
| `region` | `us` or `eu`. The `region` credential takes precedence. When neither is set, the region is `us`. |
| `baseUrl` | The API origin, for tests or a proxy. It replaces the region origin. It must be an https URL. Plain http works only for a loopback host, for tests. |

The region sets the API origin:

| Region | Origin |
|---|---|
| `us` | `https://api.mailgun.net` |
| `eu` | `https://api.eu.mailgun.net` |

Use the region of the domain. A domain in the EU region does not exist in the US API, and the US API answers with HTTP 404.

### How the adapter sends

- The adapter sends one message with `POST /v3/<domain>/messages`.
- The request body is `multipart/form-data`. Each attachment is a file part with its raw bytes.
- The adapter escapes `"`, CR, and LF in each Content-Disposition value as `%22`, `%0D`, and `%0A`.
- An attachment with a `contentId` goes as an `inline` part. Mailgun names an inline file by its filename, so the part filename is the `contentId`. Refer to it in the HTML as `cid:<contentId>`.
- Custom headers go as `h:<name>` fields. The reply-to address goes as `h:Reply-To`.
- The API key goes in a Basic auth header (`api:<key>`). The adapter never puts the key in the URL.
- `verify` reads `GET /v3/domains/<domain>`. It sends no email. A domain sending key cannot read the domain, so use an account API key for `verify`.

Mailgun has no idempotency key. The idempotency store of the mailer gives the only protection against a duplicate send.

### Status map

| HTTP status | Result |
|---|---|
| 401, 403 | `not_sent/auth` |
| 402 | `not_sent/rejected`. Mailgun uses 402 for "Request Failed", not for credits. |
| 404 | `not_sent/auth`. The domain is not in this account or in this region. |
| 429 | `not_sent/rate_limited`. The adapter reads `Retry-After`, then `X-RateLimit-Reset`. |
| 403 or 429 with a sending-limit error | `not_sent/quota` |
| 5xx | `unknown/provider_error` |

## Webhooks

Mailgun posts one event per request as JSON. The body holds a `signature` object and an `event-data` object. The signature is the HMAC-SHA256 of the timestamp and a token, under the HTTP webhook signing key. The signature does not cover `event-data`.

Use the HTTP webhook signing key as the `secret`. It is not the API key. You find it in the Mailgun dashboard under API Security.

```ts
import { mailgun } from "mailswitch/mailgun";
import { D1DedupeStore } from "mailswitch/stores/d1";
import { handleWebhook } from "mailswitch/webhooks";

interface Env {
  DB: ConstructorParameters<typeof D1DedupeStore>[0];
  MAILGUN_WEBHOOK_SIGNING_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: mailgun(),
      secret: env.MAILGUN_WEBHOOK_SIGNING_KEY,
      dedupe: new D1DedupeStore(env.DB),
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

### Rules

- The dedupe store is required. `handleWebhook` throws a `TypeError` without it, and the types refuse it.
- Use an atomic dedupe store: D1 in production, the memory store in tests. Do not use KV.
- The signed timestamp must be at most 5 minutes old and at most 1 minute in the future. Otherwise the request is refused as `stale`.
- The request must have the `application/json` content type. Otherwise the request is refused as `malformed`.
- The dedupe TTL must be at least 12 minutes, which is twice the timestamp window. `handleWebhook` throws a `TypeError` for a shorter `ttlMs`. The default TTL is 7 days.

### Token and body binding

The event key is the signature token. The adapter marks its keys as bound to the body (`bodyBoundKeys`). So the webhook router claims two keys for each event:

1. `mailgun:<endpointId>:<token>`
2. `mailgun:<endpointId>:<token>#<SHA-256 of the raw body>`

This gives these results:

| Request | Result |
|---|---|
| A new token | The event is delivered. |
| The same token and the same body, after `ack()` | A duplicate. The event list is empty. |
| The same token and the same body, while a lease is held | `in_flight` (HTTP 409). |
| The same token and the same body, after the lease expires without `ack()` | The event is delivered again. |
| The same token and a different body | `bad_signature` (HTTP 401). |

The binding holds while the first request holds its lease or after its keys are committed. When a lease expires without `ack()`, no key remains. Then the next request with that token is new.

### Event mapping

| Mailgun event | Normalized type |
|---|---|
| `delivered` | `delivered` |
| `failed` with severity `permanent` | `bounced`, `hard` |
| `failed` with severity `temporary` | `bounced`, `soft` |
| `failed` with reason `old` | `bounced`, `soft` |
| `failed` with reason `suppress-complaint` | `complained` |
| `failed` with reason `suppress-unsubscribe` | `unknown` |
| `complained` | `complained` |
| Any other event, for example `opened` | `unknown` |

`providerMessageId` is the `message-id` header without angle brackets. It matches the id in the send result.
