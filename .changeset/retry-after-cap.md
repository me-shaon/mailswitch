---
"mailswitch": patch
---

A `retryAfterMs` taken from a `Retry-After` header is now capped at one hour, and it is never `Infinity`.
