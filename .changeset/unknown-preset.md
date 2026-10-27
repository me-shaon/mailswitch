---
"mailswitch": minor
---

`parseCredentials` returns the error `{ field: "preset", code: "preset" }` for an unknown preset id. It no longer throws a `RangeError`. `createMailer` still throws a `TypeError` for it.
