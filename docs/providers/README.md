# Provider comparison

| Provider | Import | Tier | Max message size | Native idempotency | Batch | Webhooks | Guide |
|---|---|---|---|---|---|---|---|
| Resend | `mailswitch/resend` | 1 | 40 MB | Yes | 50, no attachments | Svix signature | [Resend](resend.md) |
| toSend | `mailswitch/tosend` | 1 | 10 MB | No (store claim) | 50 | HMAC, dedupe store required | [toSend](tosend.md) |
| Postmark | `mailswitch/postmark` | 1 | 10 MB | No (store claim) | 500 | Basic auth, dedupe store required | [Postmark](postmark.md) |
| Amazon SES | `mailswitch/ses` | 1 | 40 MB | No (store claim) | One request per message | SNS signature and topic allowlist | [Amazon SES](ses.md) |
| Mailgun | `mailswitch/mailgun` | 1 | 25 MB | No (store claim) | One request per message | HMAC, dedupe store required | [Mailgun](mailgun.md) |
| SendGrid | `mailswitch/sendgrid` | 1 | 20 MB | No (store claim) | One request per message | ECDSA signature, dedupe store required | [SendGrid](sendgrid.md) |
| Brevo (HTTP API) | `mailswitch/brevo` | 1 | 20 MB | Yes, for 30 minutes (also store claim) | One request per message | Bearer token, dedupe store required | [Brevo](brevo.md) |
| MailerSend | `mailswitch/mailersend` | 1 | 25 MB | No (store claim) | One request per message | HMAC, dedupe store required | [MailerSend](mailersend.md) |
| Mailjet | `mailswitch/mailjet` | 1 | 15 MB per request | No (store claim) | 50 | Basic auth, dedupe store required | [Mailjet](mailjet.md) |
| SMTP2GO | `mailswitch/smtp2go` | 1 | 50 MB | No (store claim) | One request per message | Basic or Bearer token, dedupe store required | [SMTP2GO](smtp2go.md) |
| ZeptoMail | `mailswitch/zeptomail` | 2 | 15 MB | No (store claim) | One request per message | None | [ZeptoMail](zeptomail.md) |
| Cloudflare Email (REST API) | `mailswitch/cloudflare` | 1 | 5 MiB | No (store claim) | 25, 5 at a time | None | [Cloudflare Email](cloudflare.md) |
| Cloudflare Email (Workers binding) | `mailswitch/cloudflare` | 1 | 5 MiB | No (store claim) | One call per message | None | [Cloudflare Email](cloudflare.md) |
| MailChannels | `mailswitch/mailchannels` | 1 | 30 MB | No (store claim) | One request per message | Ed25519 signature, dedupe store required | [MailChannels](mailchannels.md) |
| AhaSend | `mailswitch/ahasend` | 1 | 10 MB | Yes, for 24 hours (also store claim) | One request per message | HMAC with timestamp, dedupe store required | [AhaSend](ahasend.md) |
| Mailtrap | `mailswitch/mailtrap` | 1 | 10 MB | No (store claim) | One request per message | HMAC, dedupe store required | [Mailtrap](mailtrap.md) |
| AutoSend | `mailswitch/autosend` | 1 | 40 MB | No (store claim) | One request per message | HMAC, dedupe store required | [AutoSend](autosend.md) |
| Scaleway Transactional Email | `mailswitch/scaleway` | 2 | 2 MB | No (store claim) | One request per message | None | [Scaleway](scaleway.md) |
| Generic HTTP | `mailswitch/http` | 2 | Set by the user | No (store claim) | One request per message | None | [Generic HTTP](http.md) |
| SMTP | `mailswitch/smtp` | 1 | The server `SIZE` | No (store claim) | 50 on one connection | Brevo, from `mailswitch/smtp/brevo` | [SMTP](smtp.md) |

Every provider supports attachments, cc, bcc, reply-to, and custom headers. Brevo has no inline images: it refuses an attachment with a `contentId`. MailerSend accepts custom headers only on its Professional plan and above.

A tier 1 provider has send, attachments, credential verify, webhooks where the provider offers them, and a status map with a source for each override. A tier 2 provider has send, attachments, and verify, and every 5xx is `unknown`.

The SMTP adapter has presets. A preset fixes the host, the port, and the encryption, and sets a default daily cap.

| Preset | Host | Default daily cap |
|---|---|---|
| `gmail` | `smtp.gmail.com` | 500 |
| `google-workspace` | `smtp.gmail.com` | 2,000 |
| `brevo` | `smtp-relay.brevo.com` | 300 |
| `mailpit` | Local test server | None |
| `mailcrab` | Local test server | None |
| `custom` | You give it | None |

The SMTP adapter opens no sockets itself. Your Worker passes the `connect` function of `cloudflare:sockets` to `createMailer`. See [the SMTP guide](smtp.md).

To add your own provider, follow [Add a provider](../guides/add-a-provider.md). The conformance suite checks your adapter the same way as the built-in ones.


[Back to the README](../../README.md)
