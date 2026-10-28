---
"mailswitch": minor
---

Cut the D1 queries of a keyed `sendBatch`. `IdempotencyStore` gets the optional methods `claimMany`, `touchMany`, and `finishMany`, and `DailyCapStore` gets `reserveMany` and `releaseMany`. The D1 and memory stores have them. With them, `sendBatch` makes one store call for each step and for each chunk of up to 100 messages, so a batch of 100 messages that all go out makes 4 D1 queries instead of 400. A store without them keeps the per-message path. A subclass that overrides a single method keeps the per-message path too.

With the bulk methods, a store failure stops every message of its chunk, not only one message. Before the provider call, these messages get `not_sent/store_error`.
