---
"mailswitch": minor
---

Add the `unsubscribed` event type. It means that the recipient opted out of all mail from the sender. Mailgun, Postmark, Brevo, MailerSend, Mailjet, SMTP2GO, SendGrid, MailChannels, AhaSend, Mailtrap, and AutoSend map their unsubscribe events to it. An opt-out from one group or contact list stays `unknown`. Resend, toSend, and Amazon SES send no unsubscribe event for transactional email. The AutoSend event has no recipient, and the MailerSend, MailChannels, and AhaSend payloads are not confirmed by the provider docs.
