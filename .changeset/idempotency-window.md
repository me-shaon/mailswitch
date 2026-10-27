---
"mailswitch": minor
---

Add the `nativeIdempotencyWindowMs` provider meta field, and the `readIdempotencyKey` and `expectedIdempotencyKey` conformance fixture hooks for a derived or body-placed idempotency key.

`createMailer` writes one warning when no idempotency store is set and a provider keeps its native key for less than 7 days.

The `idempotency.conflict` conformance check now judges only the adapter result. So an adapter can read the body and change a `not_sent` status map entry to `unknown`.

The error text of `checkBrevoWebhookToken` now says "secret" instead of "token".
