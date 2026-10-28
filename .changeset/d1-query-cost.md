---
"mailswitch": minor
---

Cut the D1 queries of a send and of a webhook. `send` skips the heartbeat before its first provider call, so a keyed send with a daily cap makes 3 queries instead of 4. `DedupeStore` gets the optional methods `claimMany`, `commitMany`, and `releaseMany`. The D1 and memory stores have them. With them, `handleWebhook` makes one claim query and one commit query for each 500 event keys, instead of two queries for each event. A store without them keeps the per-event calls.
