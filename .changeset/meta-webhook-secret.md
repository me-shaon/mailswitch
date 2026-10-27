---
"mailswitch": minor
---

Add `webhookSecret` and `defaultDailyCap` to `ProviderMeta`. Each built-in provider with webhooks now describes its webhook secret: the label, the hint, and the source. `createMailer` uses the meta `defaultDailyCap` after the preset cap. No built-in provider sets it.
