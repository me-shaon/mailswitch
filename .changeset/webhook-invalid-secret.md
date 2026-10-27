---
"mailswitch": minor
---

Refuse a weak or malformed webhook secret as the new `invalid_secret` rejection (HTTP 500), instead of a thrown `TypeError`. This applies to the Postmark, Resend, SendGrid, MailChannels, Mailjet, SMTP2GO, and Brevo checks. The `check...Secret` setup helpers still throw. Code with an exhaustive switch on `WebhookRejection` must handle the new value.
