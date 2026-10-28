---
"mailswitch": minor
---

Add `bounceDetail` to `bounced` events. It holds the provider's reason text and, when the provider sends them as fields, the SMTP code and the enhanced status code. mailswitch removes control and invisible characters from the text and cuts it at 1,000 characters. The text comes from a remote mail server and can hold personal data, so escape it before you show it. The Mailjet and MailChannels field names are not confirmed by the provider docs.
