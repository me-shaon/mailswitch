# MailChannels

Last checked: 2026-10-27

The MailChannels adapter is in `mailswitch/mailchannels`. It is a tier 1 provider. It sends email with attachments through the MailChannels Email API, checks the API key, and reads signed MailChannels webhook requests.

The free MailChannels relay for Cloudflare Workers ended in 2024. That relay needed no API key. It is gone, and Domain Lockdown by Cloudflare Worker ID (`cfid`) no longer works. You now need a MailChannels Email API account and an API key.

## Set up the adapter

```ts
import { mailchannels } from "mailswitch/mailchannels";

declare const env: { MAILCHANNELS_API_KEY: string };

const adapter = mailchannels({ apiKey: env.MAILCHANNELS_API_KEY });
```

| Option | Use |
|---|---|
| `apiKey` | The API key. The `apiKey` credential takes precedence. |
| `baseUrl` | The API origin. The default is `https://api.mailchannels.net`. It must be an https URL. Plain http works only for a loopback host, for tests. |
| `dryRun` | Set `true` to add `dry-run=true` to the send call. MailChannels checks and renders the message, answers 200, and sends no email. Use it only for tests. |
| `customerHandle` | The customer handle of your MailChannels account. The webhooks need it. Sending does not need it. See [Check the account of each event](#check-the-account-of-each-event). |

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | 8 to 512 printable ASCII characters with no space. MailChannels documents no key format. |

Make the key in the MailChannels console. mailswitch sends it in the `X-Api-Key` header.

## Set up Domain Lockdown

MailChannels refuses mail from a domain that does not allow your account. For each domain that you send from, add a `TXT` record at the `_mailchannels` subdomain:

```text
_mailchannels.example.com TXT v=mc1 auth=<your account id>
```

The console footer shows your account id. Without this record, the send answer is 403, and mailswitch gives `not_sent/auth`.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /tx/v1/send`. mailswitch uses the synchronous endpoint, not `send-async`. |
| `verify` | `GET /tx/v1/usage`. It sends no email. |

mailswitch puts all recipients in one personalization, so every recipient gets the same message. It puts the text part before the HTML part. An attachment with a `contentId` goes out with `content_id`, and MailChannels puts it inline.

Limits:

- A message can have at most 1000 recipients in To, Cc, and Bcc.
- A message can be at most 30 MB after encoding.
- The custom headers can be at most 5 KB together. mailswitch refuses a larger set as `not_sent/invalid_message` before any request.
- MailChannels sets some headers itself. A custom `Authentication-Results`, `Message-ID`, `Received`, `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Content-Type`, `Content-Transfer-Encoding`, or `DKIM-Signature` header is refused as `not_sent/invalid_message` before any request.
- MailChannels has no batch of distinct messages. The mailer sends one request for each message.
- MailChannels has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.

### Delivery status

| MailChannels answer | Status and reason |
|---|---|
| 202 with a `results` entry that has `status: "sent"` | `sent`. The message id is the `message_id` of the first `sent` entry. |
| 202 with no `sent` entry, an empty `results` list, or a body that mailswitch cannot read | `unknown/provider_error` |
| 200 in dry-run mode, with a rendered message in `data` | `sent`, with no message id |
| 400 | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| 413 | `not_sent/invalid_message` |
| 429 | `not_sent/rate_limited`. MailChannels does not document this answer. |
| 500, 502, and every other 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

A 202 where every entry is `failed` is `unknown`. One personalization holds every recipient, and the MailChannels docs do not say that `failed` means that no recipient got the message.

MailChannels calls a 500 and a 502 transient. It does not state that the message did not go out. So every 5xx is `unknown`. Do not retry and do not fall back after `unknown`.

## Webhooks

MailChannels signs each webhook request with Ed25519, as an HTTP Message Signature (RFC 9421). The signature covers the `Content-Digest` header, which holds the SHA-256 digest of the body. The webhook secret in mailswitch is the MailChannels public key.

### Get the public key

1. Make a webhook in the MailChannels console, or with `POST /tx/v1/webhook?endpoint=<your URL>`.
2. Find the `keyid` in the `Signature-Input` header of a request. The docs use `mckey`.
3. Get the key with `GET https://api.mailchannels.net/tx/v1/webhook/public-key?id=<keyid>`.
4. Store the key as the webhook secret, for example in `MAILCHANNELS_WEBHOOK_PUBLIC_KEY`.

mailswitch accepts the key as base64 SubjectPublicKeyInfo text or as a PEM block. A key that is not base64 is a setup error. The webhook check then throws a `TypeError`, and the message does not hold the key.

mailswitch does not fetch the key, and it does not read the `keyid`. If MailChannels rotates its key, requests signed with the new key fail as `bad_signature`. Then get the key for the new `keyid` and update the secret.

### Check the account of each event

The MailChannels docs do not say that the signing key is unique to one account. If the key is shared, a valid signature does not prove that a request is for your account. Another MailChannels customer can then point a webhook at your URL, and the events of that account reach your app with a valid signature.

So set the `customerHandle` option to the customer handle of your account. Every event in a MailChannels body has a `customer_handle` field. mailswitch accepts a signed body only when every event in it carries your handle. When an event has another handle or no handle, the check gives `bad_signature`, and mailswitch parses no events from the body.

`mailchannels()` without `customerHandle` still sends email. But its `webhooks.verify` and `webhooks.parse` throw a `TypeError` when you call them. That is a setup error, not a bad request.

### Handle a webhook

The MailChannels adapter needs a dedupe store. MailChannels can send a batch again, and each new request has a new signature. The dedupe store drops the second copy of an event. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import type { DedupeStore } from "mailswitch";
import { mailchannels } from "mailswitch/mailchannels";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(
    request: Request,
    env: { MAILCHANNELS_WEBHOOK_PUBLIC_KEY: string; MAILCHANNELS_CUSTOMER_HANDLE: string },
  ): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: mailchannels({ customerHandle: env.MAILCHANNELS_CUSTOMER_HANDLE }),
      secret: env.MAILCHANNELS_WEBHOOK_PUBLIC_KEY,
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

mailswitch reads the `Content-Digest`, `Signature-Input`, and `Signature` headers. It applies these rules:

- `Signature-Input` must hold one signature. It must cover exactly `("content-digest")`, with an integer `created` and `alg="ed25519"`. A missing `alg`, another `alg`, another component, or a repeated parameter gives `malformed`.
- `Signature` must hold one signature with the same label as `Signature-Input`. A different label gives `malformed`.
- The signature base is `"content-digest": <Content-Digest value>`, a newline, and `"@signature-params": <the Signature-Input text after the label and =>`. It has no newline at the end.
- The `sha-256` entry of `Content-Digest` must equal the SHA-256 digest of the raw body. mailswitch compares the two in constant time.
- A `created` time more than 5 minutes in the past, or more than 1 minute in the future, gives `stale`.
- A missing header, an empty secret, or a wrong signature or digest gives `bad_signature`.
- A body that is not a JSON array, or that holds more than 1000 events, gives `malformed`.
- A signed body with an event whose `customer_handle` is missing or is not `customerHandle` gives `bad_signature`.

### Events

One request holds a JSON array of up to 1000 events. mailswitch gives one normalized event for each entry.

| MailChannels event | Normalized event |
|---|---|
| `delivered` | `delivered` |
| `hard-bounced` | `bounced`, `hard` |
| `soft-bounced` | `bounced`, `soft` |
| `complained` | `complained` |
| Any other event, for example `processed`, `dropped`, `open`, `click`, `unsubscribed`, or `test` | `unknown` |

`rawType` is the MailChannels `event` value. `occurredAt` is `timestamp` in milliseconds. The `email` field is the sender address, not the recipient. `recipient` comes from the `recipients` list, and mailswitch sets it only when the list holds one address.

MailChannels gives no event id. The event key is `<request_id>:<event>:<recipients>:<timestamp>:<url>`. The recipients are in lowercase, sorted, and joined with commas. The `url` part is set only for a `click` event.

A webhook event carries the `request_id` of the send request and no message id. So mailswitch does not set `providerMessageId` on an event. The send result holds the `message_id` of the personalization, which is a different id. To match an event to a send, use the recipient and the time.

## Live smoke test

The live smoke test sends in dry-run mode, so MailChannels sends no email. It runs only when these environment variables are set:

- `MAILSWITCH_LIVE_MAILCHANNELS_KEY`
- `MAILSWITCH_LIVE_MAILCHANNELS_FROM`
- `MAILSWITCH_LIVE_TO`

## Links

- [Send an email](https://docs.mailchannels.com/api-reference/send/send-an-email)
- [Errors](https://docs.mailchannels.com/email-api/errors)
- [Retrieve usage stats](https://docs.mailchannels.com/api-reference/usage/retrieve-usage-stats)
- [Domain Lockdown](https://docs.mailchannels.com/email-api/domain-lockdown)
- [Webhooks](https://docs.mailchannels.com/email-api/webhooks)
- [Webhook event types](https://docs.mailchannels.com/email-api/webhook-event-types)
- [Webhook JSON schema](https://docs.mailchannels.com/email-api/webhook-schema)
- [Retrieve the webhook signing key](https://docs.mailchannels.com/api-reference/webhooks/retrieve-webhook-signing-key)
