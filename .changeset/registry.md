---
"mailswitch": minor
---

Add `mailswitch/registry`. `createAdapter(id, options)` builds the adapter of a catalog provider id and loads only the code of that provider. The options are typed for each id and never hold credentials. `cloudflare-binding` needs a binding, and `http` needs its JSON config. A Worker bundler still puts every provider in the upload.
