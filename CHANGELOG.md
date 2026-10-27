# mailswitch

## 0.2.0

### Minor Changes

- 56edc6e: Add the Brevo API provider at `mailswitch/brevo`, with native idempotency and Brevo webhooks.
- 56edc6e: Add the `nativeIdempotencyWindowMs` provider meta field, and the `readIdempotencyKey` and `expectedIdempotencyKey` conformance fixture hooks for a derived or body-placed idempotency key.
  
  `createMailer` writes one warning when no idempotency store is set and a provider keeps its native key for less than 7 days.
  
  The `idempotency.conflict` conformance check now judges only the adapter result. So an adapter can read the body and change a `not_sent` status map entry to `unknown`.
  
  The error text of `checkBrevoWebhookToken` now says "secret" instead of "token".
- 56edc6e: Add the MailerSend provider at `mailswitch/mailersend`.
- 56edc6e: Add the Mailjet provider at `mailswitch/mailjet`, with a native batch send.
- 56edc6e: Add the SendGrid provider at `mailswitch/sendgrid`.
- 56edc6e: Add the SMTP2GO provider at `mailswitch/smtp2go`, with a region option.
- 56edc6e: Add the ZeptoMail provider at `mailswitch/zeptomail` at tier 2, with a region credential.

## 0.1.1

### Patch Changes

- 7993a02: Adapter options such as `smtp({ preset })` now apply under `createMailer` when the credentials do not set the same field.

## 0.1.0

### Minor Changes

- 6859afc: First release of mailswitch: transactional email for Cloudflare Workers.
  
  - One `send()` API for Resend, toSend, Postmark, Amazon SES, Mailgun, Cloudflare Email, and SMTP.
  - Every send result is `sent`, `not_sent`, or `unknown`.
  - Fallback to a second provider happens only after `not_sent`.
  - Idempotency keys stop duplicate sends, also for providers with no native key.
  - `sendBatch()` sends many fully built messages.
  - Daily caps and rate limits per provider.
  - Memory, D1, and Durable Object stores.
  - Webhook signature checks, replay protection, and one normalized event type.
  - SMTP presets for Gmail, Google Workspace, Brevo, Mailpit, and MailCrab.
  - Provider catalog, credential checks, `verify()`, and test send for settings screens.
  - AES-GCM key ring for credentials at rest.
  - Conformance suite and `mailswitch-scaffold` command to add a provider.
  - Zero runtime dependencies. Each provider is its own subpath import.
