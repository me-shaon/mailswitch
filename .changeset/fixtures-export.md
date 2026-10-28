---
"mailswitch": minor
---

Export the provider webhook fixtures at `mailswitch/conformance/fixtures`, for app tests. Each provider gives its test secret, a sign helper that takes a time, and event body builders. The names and helper signatures follow semver. The sample bodies follow the provider docs and can change in a minor release.
