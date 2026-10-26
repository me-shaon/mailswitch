# SMTP

Last checked: 2026-10-26

The SMTP adapter is in `mailswitch/smtp`. It is a tier 1 provider. It sends email with attachments through any SMTP submission server. It sends batches on one connection and checks the login. The optional `mailswitch/smtp/brevo` subpath adds Brevo webhooks.

## Give the adapter a socket

The adapter does not open sockets itself. It does not import `cloudflare:sockets`. Your Worker imports `connect` from `cloudflare:sockets` and gives it to mailswitch.

```ts
import { connect } from "cloudflare:sockets";
import { createMailer } from "mailswitch";
import { smtp } from "mailswitch/smtp";

declare const env: { BREVO_SMTP_LOGIN: string; BREVO_SMTP_KEY: string };

const mailer = createMailer({
  providers: [
    {
      adapter: smtp(),
      preset: "brevo",
      credentials: { username: env.BREVO_SMTP_LOGIN, password: env.BREVO_SMTP_KEY },
    },
  ],
  connect: (target) =>
    connect(
      { hostname: target.hostname, port: target.port },
      { secureTransport: target.secureTransport, allowHalfOpen: false },
    ),
});
```

You can also give the function to the adapter: `smtp({ connect })`. The `connect` of the send context takes precedence.

When no `connect` function is available, `send` returns `not_sent/unsupported`. It does not throw.

Cloudflare blocks outbound connections to port 25. Use port 587 with STARTTLS, or port 465 with implicit TLS.

## Set up the adapter

```ts
import { smtp } from "mailswitch/smtp";

const adapter = smtp({ heloName: "mail.example.com" });
```

| Option | Use |
|---|---|
| `connect` | The socket function, when the send context gives none. |
| `heloName` | The name in `EHLO`. The default is the domain of the From address. |
| `webhooks` | The webhook methods of a relay, for example `brevoWebhooks()`. See [Brevo webhooks](#brevo-webhooks). |
| `preset`, `host`, `port`, `security`, `insecure`, `username`, `password` | Default connection values. The credentials take precedence. |

The order of precedence is: the fixed values of the preset, then the credentials, then the adapter options.

## Credentials

| Field | Secret | Required | Rule |
|---|---|---|---|
| `preset` | No | No | `gmail`, `google-workspace`, `brevo`, `mailpit`, `mailcrab`, or `custom`. The default is `custom`. |
| `host` | No | Yes | A host name, for example `smtp.example.com`. A preset can fix it. |
| `port` | No | No | 1 to 65535. The default is 587 for `starttls`, 465 for `tls`, and 1025 for Mailpit and MailCrab. |
| `security` | No | No | `starttls`, `tls`, or `none`. The default is `starttls`. |
| `insecure` | No | No | `true` or `false`. The default is `false`. `security: "none"` needs `true`. |
| `username` | No | No | The login. Leave it empty for a server that needs no login. |
| `password` | Yes | No | The password or the SMTP key. |

## Presets

A preset fixes some credential fields. Give the preset id in `createMailer`, or set the `preset` credential.

| Preset | Host | Port and encryption | Default daily cap |
|---|---|---|---|
| `gmail` | `smtp.gmail.com` | 587, STARTTLS | 500 |
| `google-workspace` | `smtp.gmail.com` | 587, STARTTLS | 2,000 |
| `brevo` | `smtp-relay.brevo.com` | 587, STARTTLS | 300 |
| `mailpit` | You give it | 1025, plain text | None |
| `mailcrab` | You give it | 1025, plain text | None |
| `custom` | You give it | You give it | None |

The caps come from the providers' own pages:

- Gmail sends to at most 500 recipients a day from a personal account.
- Google Workspace sends at most 2,000 messages a day for each user.
- The free Brevo plan sends 300 emails a day. Set the cap of your Brevo plan.

The cap applies only when the mailer has a `dailyCaps` store. You can set `dailyCap` to change it.

Gmail and Google Workspace need an app password, not the normal password. Turn on 2-Step Verification first. Google shows the app password in groups of four characters. The adapter removes the spaces.

Mailpit and MailCrab are local test servers. Use them only in development and tests.

## The TLS rule

The adapter sends the login and the message only over TLS:

- With `security: "tls"`, the socket uses TLS from the first byte.
- With `security: "starttls"`, the server must offer `STARTTLS`, and the upgrade must complete. If the server does not offer `STARTTLS`, the adapter stops. It writes no `AUTH` line and no message. The result is `not_sent/auth`.
- With `security: "none"`, the connection stays in plain text. This needs `insecure: true`. Without it, the adapter refuses the send before it connects. Only the Mailpit and MailCrab presets set `insecure: true`.

The platform checks the TLS certificate. The adapter cannot turn that check off.

## Send

| Call | What it does |
|---|---|
| `send` | One connection for one message. |
| `sendBatch` | One connection for up to 50 messages. A refused message does not stop the next one. |
| `verify` | The greeting, TLS, and the login, then `QUIT`. It sends no email. |

The adapter builds a MIME message with the shared MIME builder:

- A message with attachments is `multipart/mixed`.
- Text bodies are UTF-8 quoted-printable. Attachments are base64 in lines of 76 characters.
- No line is longer than 998 characters.
- A line that starts with a dot gets a second dot (dot-stuffing).
- Bcc recipients go in the envelope only.

When the server advertises `SIZE`, a larger message gets `not_sent/invalid_message` before `MAIL FROM`.

SMTP has no idempotency key. Use an idempotency store in the mailer to stop a duplicate send.

The `providerMessageId` is the queue id from the reply to the final dot, for example `queued as 4Bx9Zp`. When the server gives no queue id, it is the `Message-ID` header of the message.

### Delivery status

The boundary is the `354` reply to `DATA`. Before it, the server has no message. After it, the message may have gone out.

| SMTP outcome | Status and reason |
|---|---|
| `250` to the final dot | `sent` |
| The connect fails, or the server closes before `DATA` | `not_sent/network` |
| No reply before `DATA` | `not_sent/timeout` |
| `530`, `534`, `535`, `538`, or any 5xx to `AUTH` | `not_sent/auth` |
| No `STARTTLS`, a refused `STARTTLS`, or plain text without `insecure` | `not_sent/auth` |
| `421`, `450`, `451`, `452`, or `454` before `DATA` | `not_sent/rate_limited` |
| A 5xx with rate words, for example "too many" | `not_sent/rate_limited` |
| Quota words, or the enhanced code `5.4.5` | `not_sent/quota` |
| A 5xx to `MAIL FROM`, `RCPT TO`, or `DATA` | `not_sent/rejected` (`501`, `552`, and `555` give `invalid_message`) |
| A timeout after the `354` | `unknown/timeout` |
| The connection closes after the `354` | `unknown/network` |
| Any reply other than `250` to the final dot | `unknown/provider_error` |

A refusal of the final dot is also `unknown`. The server has the whole message at that point. Do not retry and do not fall back after `unknown`.

In a batch, the message in flight gets the status of the failure. A message after a lost connection did not start, so it gets `not_sent`.

Result messages hold only the SMTP code and the command. They never hold the reply text, the commands, or any `AUTH` line.

## Brevo webhooks

SMTP itself has no events, so `smtp()` has no webhook methods. The Brevo preset can send bounce, complaint, and delivery events. The Brevo code is in the optional `mailswitch/smtp/brevo` subpath, so other SMTP users do not load it. Give its webhook methods to the adapter:

```ts
import { smtp } from "mailswitch/smtp";
import { brevoWebhooks } from "mailswitch/smtp/brevo";

const adapter = smtp({ preset: "brevo", webhooks: brevoWebhooks() });
```

With `webhooks`, the adapter meta sets `webhooks: true`, and the adapter needs a dedupe store. Use the same adapter in `createMailer` and in `handleWebhook`. The catalog shows `webhooks: false` for SMTP, because a plain SMTP server sends no events.

Brevo signs nothing. It sends a bearer token that you set on the webhook. mailswitch uses the token as the webhook secret.

### Make the token

The token must hold at least 128 bits. A token of only hex characters needs at least 32 characters. Any other token needs at least 22 characters. Make it with `generateBrevoWebhookToken()`, which gives 256 random bits as 43 base64url characters.

A token that is too short is a setup error. The webhook check throws a `TypeError`. The message does not hold the token.

### Set up the webhook in Brevo

Brevo sets bearer auth only through its API. Run this command once, with your Brevo API key and your token:

```sh
curl -X POST https://api.brevo.com/v3/webhooks \
  -H "api-key: YOUR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"type":"transactional","url":"https://app.example.com/hooks/brevo","events":["delivered","hardBounce","softBounce","invalid","spam"],"auth":{"type":"bearer","token":"YOUR_TOKEN"}}'
```

`BREVO_WEBHOOK_EVENTS` holds the list of events.

### Handle a webhook

An SMTP adapter with webhooks needs a dedupe store. The token covers no timestamp, so a replayed request passes the check. The dedupe store is the only replay guard. `handleWebhook` throws when the store is missing.

```ts
import { smtp } from "mailswitch/smtp";
import { brevoWebhooks } from "mailswitch/smtp/brevo";
import type { DedupeStore } from "mailswitch";
import { handleWebhook } from "mailswitch/webhooks";

declare const dedupe: DedupeStore;

export default {
  async fetch(request: Request, env: { BREVO_WEBHOOK_TOKEN: string }): Promise<Response> {
    const outcome = await handleWebhook(request, {
      adapter: smtp({ preset: "brevo", webhooks: brevoWebhooks() }),
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

The token does not cover the body. Use HTTPS for the webhook URL, so nobody can read the token or change the body.

### How the check works

- The scheme name is read without regard to case.
- mailswitch compares the SHA-256 digest of the token in the request with the SHA-256 digest of the secret. The compare takes the same time for any input.
- A missing header or a different scheme gives `bad_signature`. A header that is not `<scheme> <token>` gives `malformed`. A body that is not JSON gives `malformed`.

### Events

| Brevo event | Normalized event |
|---|---|
| `delivered` | `delivered` |
| `hard_bounce`, `invalid_email` | `bounced`, `hard` |
| `soft_bounce` | `bounced`, `soft` |
| `spam` | `complained` |
| Any other event, for example `opened` or `blocked` | `unknown` |

`rawType` is the Brevo event name. One request can hold one event, or a list when Brevo batching is on.

Brevo sends no event id. The event key is `<event>:<message-id>:<recipient>:<time>`. The time is `ts_epoch` in milliseconds, or `ts_event` in seconds. These fields do not change when Brevo sends the same event again.

## Links

- [RFC 6409, message submission](https://www.rfc-editor.org/rfc/rfc6409)
- [Gmail SMTP errors](https://support.google.com/a/answer/3726730)
- [Gmail sending limits](https://support.google.com/mail/answer/22839)
- [Google Workspace sending limits](https://support.google.com/a/answer/166852)
- [Brevo transactional webhooks](https://developers.brevo.com/docs/transactional-webhooks)
- [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Mailpit SMTP](https://mailpit.axllent.org/docs/configuration/smtp/)
