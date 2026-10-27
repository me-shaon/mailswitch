# mailswitch

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
