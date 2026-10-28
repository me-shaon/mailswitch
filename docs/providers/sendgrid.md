# SendGrid

Last checked: 2026-10-27

The SendGrid adapter is in `mailswitch/sendgrid`. It is a tier 1 provider. It sends email with attachments, checks the API key, and reads signed SendGrid Event Webhook requests.

SendGrid retired its free plan in 2025. You need a paid plan or a trial to send email. mailswitch sets no daily cap for SendGrid. Set a cap in the mailer if your plan has one.

## Set up the adapter

```ts
import { sendgrid } from "mailswitch/sendgrid";

declare const env: { SENDGRID_API_KEY: string };

const adapter = sendgrid({ apiKey: env.SENDGRID_API_KEY });
```

| Option | Use |
|---|---|
| `apiKey` | The API key. The `apiKey` credential takes precedence. |
| `baseUrl` | The API origin. The default is `https://api.sendgrid.com`. For an EU regional subuser, set `https://api.eu.sendgrid.com` (the `SENDGRID_EU_API_BASE` export). It must be an https URL. Plain http works only for a loopback host, for tests. |
| `sandbox` | Set `true` to turn on SendGrid sandbox mode. SendGrid checks the request and answers 200, but it delivers no email. Use it only for tests. |

An EU regional subuser must use the EU origin:

```ts
import { SENDGRID_EU_API_BASE, sendgrid } from "mailswitch/sendgrid";

const adapter = sendgrid({ baseUrl: SENDGRID_EU_API_BASE });
```

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `apiKey` | Yes | Yes | A key that starts with `SG.`. It needs the **Mail Send** permission. |

Make the key in the SendGrid console, under **Settings**, then **API Keys**. SendGrid shows the key only once. A restricted key with only **Mail Send** is enough.

## Send

| Call | Endpoint |
|---|---|
| `send` | `POST /v3/mail/send` |
| `verify` | `GET /v3/scopes`. It sends no email. The key must have the `mail.send` scope. |

mailswitch puts all recipients in one personalization, so every recipient gets the same message. It puts the text part before the HTML part, as SendGrid requires. An attachment with a `contentId` goes out as an inline attachment with `content_id`.

Limits:

- A message can have at most 1000 recipients in To, Cc, and Bcc.
- A message can be at most 20 MB after encoding.
- The display name of the `from` address must hold only ASCII characters. SendGrid does not accept Unicode there. mailswitch refuses such a message as `not_sent/unsupported` before any request.
- SendGrid has no batch of distinct messages. The mailer sends one request for each message.
- SendGrid has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.

### Delivery status

| SendGrid answer | Status and reason |
|---|---|
| 202, or 200 in sandbox mode | `sent`. The message id is the `X-Message-Id` header. |
| 400 | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| 413 | `not_sent/invalid_message` |
| 429 | `not_sent/rate_limited` |
| 500 and every other 5xx | `unknown/provider_error` |
| Timeout or network error | `unknown` |

A 429 from SendGrid has no `Retry-After` header. mailswitch computes `retryAfterMs` from the `X-RateLimit-Reset` header, which holds a time in Unix seconds.

SendGrid does not state that a message did not go out after a 5xx. So every 5xx is `unknown`. Do not retry and do not fall back after `unknown`.

## Webhooks

SendGrid signs each Event Webhook request with ECDSA P-256 and SHA-256. The signature covers the timestamp header and the raw body. The webhook secret in mailswitch is the public verification key from SendGrid.

### Set up the webhook in SendGrid

1. In the SendGrid console, open **Settings**, then **Mail Settings**, then **Webhook Settings**, then **Event Webhooks**.
2. Make a webhook, or open the settings of a webhook.
3. Enter the HTTPS URL of your endpoint.
4. Select **Delivered**, **Bounced**, and **Spam Reports**. You can select other events. mailswitch gives them the type `unknown`.
5. Turn on **Signature Verification**. Save the webhook.
6. Open the webhook again. Copy the **Verification Key**. SendGrid makes the key pair only when you save. The test button does not check the signature before you save.
7. Store the key as the webhook secret, for example in `SENDGRID_WEBHOOK_PUBLIC_KEY`.

The key is base64 text that starts with `MFkw`. mailswitch also accepts the key in PEM form. A key that is not base64 is a setup error. The webhook check refuses each request as `invalid_secret`, which maps to HTTP 500. The provider retries after you fix the key.

### Handle a webhook

The SendGrid adapter needs a dedupe store. SendGrid sends a failed request again, and each retry has a new timestamp and a new signature. The dedupe store drops the second copy of an event. `handleWebhook` requires the store in its types, and it throws when the store is missing.

```ts
import type { DedupeStore } from "mailswitch";
import { sendgrid } from "mailswitch/sendgrid";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(
    request: Request,
    env: { SENDGRID_WEBHOOK_PUBLIC_KEY: string },
  ): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: sendgrid(),
      secret: env.SENDGRID_WEBHOOK_PUBLIC_KEY,
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

- mailswitch reads the `X-Twilio-Email-Event-Webhook-Signature` and `X-Twilio-Email-Event-Webhook-Timestamp` headers.
- It checks the DER signature over the timestamp text followed by the raw body bytes.
- A timestamp more than 5 minutes in the past or in the future gives `stale`.
- A missing header or a wrong signature gives `bad_signature`. A header that cannot be read, or a body that is not a JSON array, gives `malformed`.

### Events

One request holds a JSON array of events. mailswitch gives one normalized event for each entry.

| SendGrid event | Normalized event |
|---|---|
| `delivered` | `delivered` |
| `bounce` with `type` `bounce` | `bounced`, `hard` |
| `bounce` with `type` `blocked` | `bounced`, `soft` |
| `spamreport` | `complained` |
| Any other event, for example `open`, `dropped`, or `deferred` | `unknown` |

`rawType` is the SendGrid `event` value. `recipient` is `email`. `occurredAt` is `timestamp` in milliseconds.

The event key is `sg_event_id`, which SendGrid gives for dedupe. An event without it gets `<sg_message_id>:<event>:<timestamp>:<email>:<index>`.

`providerMessageId` is `sg_message_id`, unchanged. It starts with the `X-Message-Id` value of the send, followed by a dot and more text. To match an event to a send, compare the part before the first dot.

### Bounce detail

A `bounced` event carries `bounceDetail` when SendGrid sends these fields:

- `text`: `reason`.
- `enhancedCode`: `status`.

The text comes from a remote mail server and can hold personal data. mailswitch does not escape markup in it. Escape the text before you show it.

## Links

- [Mail Send API](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send)
- [API key scopes](https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access)
- [Rate limits](https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/rate-limits)
- [Event Webhook security](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
- [Event Webhook reference](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event)
