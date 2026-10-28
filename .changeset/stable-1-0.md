---
"mailswitch": major
---

Release 1.0. The public API is now stable and follows semantic versioning. A minor release can add a value to the `NormalizedEventType`, `WebhookRejection`, and `FailureReason` unions, so give each `switch` on them a `default` case. `DeliveryStatus` stays `sent`, `not_sent`, or `unknown`. The package now describes itself as a transactional email library that sends through any provider.

Code that handles `NormalizedEventType` with an exhaustive `switch` must handle the new `unsubscribed` type.
