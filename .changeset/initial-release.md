---
"mailswitch": minor
---

First release. Send transactional email from Cloudflare Workers with one API and a fallback chain.

- Providers: Resend, toSend, Postmark, Amazon SES, Mailgun, Cloudflare Email (REST API and Workers binding), and SMTP with Gmail, Google Workspace, Brevo, Mailpit, and MailCrab presets. Each provider is its own subpath export.
- Delivery safety: every result is `sent`, `not_sent`, or `unknown`. mailswitch never retries or falls back after `unknown`.
- Idempotency: one store claim per keyed message, with the native key where the provider has one.
- `sendBatch()` for fully built messages, per-provider rate limits, and daily caps.
- Stores: memory, D1 (with the schema at `mailswitch/stores/d1-schema.sql`), and Durable Objects (`MailswitchLimiter` and `MailswitchIdempotency`).
- Webhooks: signature checks over the raw body, two-phase dedupe, and normalized events. Brevo SMTP webhooks are in `mailswitch/smtp/brevo`.
- Settings screens: `mailswitch/catalog`, `parseCredentials`, `createSendContext`, `sendTestEmail`, and `mailswitch/crypto` for credentials at rest.
- Extension kit: `mailswitch/provider-kit`, `mailswitch/conformance`, and the `mailswitch-scaffold` command.
