# Add a provider

Last checked: 2026-10-26

This guide tells you how to add an email provider to mailswitch. A person and a coding agent can follow it with no other context. You make an adapter, record fixtures, and run the conformance suite. The suite is the pass or fail gate for every provider.

The worked example is Lettermill. Lettermill is a fictional provider. Its full adapter is in `test/scaffold/lettermill/`, and it passes the suite at tier 2.

## Contents

1. [Choose a mode](#choose-a-mode)
2. [Create the files](#create-the-files)
3. [The meta and index split](#the-meta-and-index-split)
4. [The adapter contract](#the-adapter-contract)
5. [Delivery status and the status map](#delivery-status-and-the-status-map)
6. [Tiers](#tiers)
7. [Write send](#write-send)
8. [Write verify](#write-verify)
9. [Webhooks](#webhooks)
10. [Redaction](#redaction)
11. [Record fixtures](#record-fixtures)
12. [Run the conformance suite](#run-the-conformance-suite)
13. [Register a built-in provider](#register-a-built-in-provider)
14. [Checklist](#checklist)

## Choose a mode

For a simple JSON API, you may not need an adapter. The generic HTTP provider in `mailswitch/http` sends to any `https` endpoint from a code callback or a JSON config, with no adapter code. See the [generic HTTP guide](../providers/http.md). Write an adapter when the provider has webhooks, native idempotency, or answers that need their own rules.

There are two modes. The files and the rules are the same in both modes. Only the import paths and the file locations change.

| Mode | Use it for | Imports |
|---|---|---|
| Repository | A built-in provider in the mailswitch repository. | Relative paths in `src/`. |
| Custom | A provider in your own project. mailswitch does not ship it. | `mailswitch`, `mailswitch/provider-kit`, `mailswitch/conformance`, and `mailswitch/conformance/vitest`. |

A custom provider needs no deep imports. It uses the same helpers as the built-in providers.

## Create the files

The scaffold command writes four files from templates. The provider id is a lowercase letter, then 1 to 31 lowercase letters, digits, or hyphens. Use the same id in every file and in `meta.id`. The id is stored with keys and caps, so do not change it later.

Repository mode. Run the command in the root of the repository:

```sh
node bin/scaffold.mjs lettermill
```

Custom mode. Run the command in your project, with a target directory:

```sh
npx mailswitch-scaffold lettermill --out src/email/lettermill
```

The command writes these files:

| File | Repository path | Custom path (in `--out`) |
|---|---|---|
| Provider data | `src/providers/<id>/meta.ts` | `meta.ts` |
| Adapter | `src/providers/<id>/index.ts` | `index.ts` |
| Fixture | `src/conformance/fixtures/<id>.ts` | `<id>.fixture.ts` |
| Conformance test | `test/providers/<id>.conformance.test.ts` | `<id>.conformance.test.ts` |

The command refuses an invalid id and an id that is a JavaScript reserved word. It refuses an id that already has a folder in `src/providers/`. It never writes over a file. Exit code 0 means that it wrote the files. Exit code 1 means a usage error or a refusal.

The scaffold output typechecks. Its `send` is a stub that returns `not_sent/unsupported` with the text `SCAFFOLD STUB`. Its `verify` is a working example call. The conformance test runs at once. It fails only the checks that need a real `send`:

`declaration.tier`, `send.ok`, `send.auth`, `send.invalid`, `send.rate-limited`, `send.uncertain`, `send.headers`, `attachments`.

Search for `TODO(scaffold)` and `SCAFFOLD STUB`. Replace each one.

## The meta and index split

Each provider has two source files.

- `meta.ts` holds pure data: the id, the name, the tier, the capabilities, the credential fields, the presets, the docs URL, and the status map. `mailswitch/catalog` imports only meta files, so a settings form can load provider data with no adapter code.
- `index.ts` imports its meta. It adds `send`, the optional `sendBatch`, `verify`, and the optional webhook methods. It also exports the meta.

In the repository, `meta.ts` can import only `../../core/meta`, `../../core/classify`, and `../../core/types`. The catalog test fails any other import. In a custom provider, `meta.ts` imports from `mailswitch/provider-kit`.

### Meta fields

| Field | Rule |
|---|---|
| `id` | Lowercase letters, digits, and hyphens. It is stable. |
| `name` | The provider name that a user sees. |
| `tier` | `1` or `2`. See [Tiers](#tiers). |
| `capabilities` | What the provider can send. See the next table. |
| `credentialFields` | The fields of the credential form. At least one field is `required`. Mark a key or a token `secret: true`. Use `apiKey` for a single API key. `pattern` is the source of a regular expression. Anchor it with `^` and `$`. For a choice, such as a region, set `options` and `defaultValue`. |
| `presets` | Optional. For a provider that serves many services, for example SMTP hosts. A preset can set `defaultDailyCap`. |
| `docsUrl` | The provider documentation. It must start with `https://`. |
| `statusMap` | Sourced overrides of the default status table. Build it with `defineStatusMap`. |
| `webhooks` | `true` only when the adapter has `webhooks.verify` and `webhooks.parse`. |
| `webhookSecret` | Set it when `webhooks` is `true`. It describes the value that `handleWebhook` takes as `secret`, so a settings form can show the input. Give a `label` and a `source`. Use `"provider"` when the user copies the value from the provider. Use `"generated"` when the user makes it with a generate helper of the adapter. Put any fixed username or format rule in `hint`. `pattern` is optional. |
| `defaultDailyCap` | Optional. A positive integer. `createMailer` uses it when an entry has no `dailyCap` and the `dailyCaps` store is set. A preset `defaultDailyCap` takes precedence. The built-in providers leave it out, because free-plan limits change often. |
| `nativeIdempotency` | `true` only when the provider accepts an idempotency key and drops a repeat. It must equal `capabilities.idempotency`. |
| `nativeIdempotencyWindowMs` | Optional. How long the provider keeps a key, in milliseconds. It must be a positive integer, and it needs `nativeIdempotency: true`. Set it when the window is shorter than 7 days. `createMailer` then warns when no idempotency store is set. |

`defineProviderMeta` checks these rules and freezes the object. It throws a `TypeError` for a programmer error.

### Capabilities

| Capability | Set it to |
|---|---|
| `attachments` | `true` when the provider accepts attachments. Tier 1 and tier 2 need it. |
| `maxMessageBytes` | The largest message after base64 encoding, in bytes. `null` when the provider states no limit. |
| `cc`, `bcc`, `replyTo` | `true` when the provider accepts them. |
| `customHeaders` | `true` when the provider passes custom headers unchanged. |
| `idempotency` | `true` when the provider accepts an idempotency key. |
| `batchSize` | The messages in one `sendBatch` call. `1` when the provider has no batch endpoint. |
| `maxRecipients` | The largest number of recipients across to, cc, and bcc. Leave it out for no limit. |

`validateMessage(message, meta.capabilities)` refuses a message that needs a missing capability. The refusal is `not_sent/unsupported`, and it happens before any network call.

## The adapter contract

The contract is in `src/core/adapter.ts`. Read the comments in that file. They are part of the contract.

```ts
interface ProviderAdapter {
  meta: ProviderMeta;
  send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult>;
  sendBatch?(messages: readonly OutgoingMessage[], ctx: SendContext): Promise<SendResult[]>;
  verify(ctx: SendContext): Promise<VerifyResult>;
  webhooks?: ProviderWebhooks;
}
```

| Member | Required | What it does |
|---|---|---|
| `send` | Yes | Sends one message. It returns one `SendResult`. |
| `sendBatch` | No | Sends up to `batchSize` messages in one call. It returns one result per message, in order. When it is absent, the core calls `send` for each message. |
| `verify` | Yes | Checks the credentials with a cheap authenticated call. It must not send email. |
| `webhooks` | When `meta.webhooks` is true | `verify` checks a webhook signature. `parse` turns a verified body into normalized events. |

`SendContext` holds:

| Field | Use |
|---|---|
| `fetch` | Make every HTTP call with it. Do not use the global `fetch`. The suite replaces it with recorded exchanges. |
| `timeoutMs` | The timeout of one request. Pass it to `callProvider`. |
| `credentials` | The parsed credentials, by field name. They take precedence over adapter options. |
| `defaultedFields` | Optional. The credential fields whose value is the `defaultValue` of the field, because the caller left them empty. `createMailer` sets it. To let an adapter option take precedence over a default, use the option when the field is in this set. |
| `now` | The current time in Unix milliseconds. Use it for `Retry-After` dates. The suite sets a fixed clock. |
| `connect` | Outbound TCP, for SMTP. HTTP adapters ignore it. |

Rules for every adapter:

- Return a result for every provider failure. Do not throw. Throw only for a programmer error, such as an invalid option.
- Use only Web APIs: `fetch`, Web Crypto, `TextEncoder`, `TextDecoder`, and streams. Do not use Node APIs. Do not import `cloudflare:*` modules.
- Do not import from another provider. Shared code goes in `src/internal/` in the repository.
- Set `provider: meta.id` on each result.
- Wrap the adapter in `defineProvider`. It checks the shape and throws for a programmer error.

### Helpers in mailswitch/provider-kit

| Helper | What it does |
|---|---|
| `defineProvider`, `defineProviderMeta`, `defineStatusMap` | Check and freeze an adapter, its meta, and its status map. |
| `callProvider(request)` | Sends one request with a timeout. Any status gives `{ ok: true, response }`. A timeout gives `unknown/timeout`. Any other thrown error gives `unknown/network`. |
| `classifyResponse(status, headers, statusMap, { now })` | The status and the reason of an HTTP status. It reads `Retry-After` into `retryAfterMs`. Its message never holds the response body. |
| `classifyThrown(error, options)` | The `unknown` result of a thrown error, for a transport that does not use `callProvider`. |
| `parseRetryAfter(value, now)` | `Retry-After` in milliseconds, from delta seconds or an HTTP date. |
| `readJson(response)` | Reads a JSON body. Returns null for an empty or an invalid body. |
| `discardBody(response)` | Releases a body that you do not read. |
| `checkCapabilities` | The capability part of `validateMessage`. |
| `bytesToBase64`, `base64ToBytes`, `isBase64`, `bytesToHex`, `utf8`, `utf8ByteLength` | Byte and text helpers. |
| `hmacSign`, `hmacVerify` | HMAC on Web Crypto. `hmacVerify` uses `crypto.subtle.verify`, which compares in constant time. |
| `redactUrl(url)` | Removes the query, the fragment, and any credentials from a URL. |

`validateMessage` and the message and result types come from `mailswitch`.

## Delivery status and the status map

Every send result has one of three statuses.

| Status | Meaning | A retry or a fallback |
|---|---|---|
| `sent` | The provider accepted the message. | Not needed. |
| `not_sent` | The message did not go out. | Is safe. It cannot send a duplicate. |
| `unknown` | The message may have gone out. | Is not safe. Never retry or fall back after `unknown`. |

When in doubt, use `unknown`. An adapter can refine the reason of a `not_sent` result. It cannot change `unknown` to `not_sent` outside the status map.

### The default table

`classifyResponse` applies this table:

| Outcome | Status and reason |
|---|---|
| 2xx | `sent` |
| 400, 413, 415, 422 | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| 402 | `not_sent/credits` |
| 429 | `not_sent/rate_limited`, with `retryAfterMs` |
| Other 4xx | `not_sent/rejected` |
| 5xx and any other code | `unknown/provider_error` |
| Timeout after the fetch started | `unknown/timeout` |
| Any thrown fetch error | `unknown/network` |
| Refusal before the fetch | `not_sent` (for example `invalid_message` or `unsupported`) |

A Workers fetch throws the same `TypeError` for a DNS failure and for a reset after the body went out. So every thrown error is `unknown`.

### Status map rules

- Add an override only when the provider documentation proves it. Each entry needs a `source` URL of that documentation.
- A tier 2 provider cannot map a 5xx to `not_sent`. `defineProviderMeta` throws, and the suite fails it.
- A tier 1 provider can map a 5xx to `not_sent` only with a source that proves the message did not go out.
- A 4xx that means "a request with this key is in progress or used" maps to `unknown`. The earlier request may have sent. An example is the Resend 409 idempotency response.

Lettermill documents that a 409 means "a message with this content is in progress":

```ts
statusMap: defineStatusMap({
  409: {
    status: "unknown",
    reason: "provider_error",
    source: "https://lettermill.example/docs/api/errors",
  },
}),
```

### Failure reasons

| Reason | Use it for |
|---|---|
| `auth` | A wrong, restricted, or suspended key. |
| `rate_limited` | A throttle, usually 429. Copy `Retry-After` into `retryAfterMs`. |
| `quota` | A daily or monthly sending limit of the provider. |
| `credits` | No credits or balance left, usually 402. |
| `rejected` | A valid message that the provider refuses, for example a suppressed address. |
| `invalid_message` | A request or an address that the provider finds not valid. |
| `provider_error` | A 5xx, or a response that the adapter cannot read. |
| `unsupported` | A message that needs a capability that the provider does not have. |
| `timeout`, `network` | Transport failures. `callProvider` gives them. |
| `idempotency_conflict` | A key used before with a different payload. |

The core pipeline sets `daily_cap`, `stale_pending`, `in_flight`, and `store_error`. An adapter does not.

## Tiers

The tier is the bar that a provider meets. Declare it in `meta.tier` and in the test call. The two values must match.

| Bar | Tier 2 | Tier 1 |
|---|---|---|
| `send` with attachments | Yes | Yes |
| `verify` | Yes | Yes |
| Webhooks, when the provider offers them | Optional | Required |
| Status map | Every 5xx stays `unknown`. | Researched. Each override has a source. |
| Native idempotency, when the provider offers it | Optional | Required |

The scaffold writes tier 2. Start at tier 2. Raise the provider to tier 1 when it meets every tier 1 bar.

## Write send

Read the provider API reference for the send call and its errors. Then follow these steps. The code comes from the Lettermill adapter. A custom provider imports the same names from the package.

```ts
import {
  type NotSentResult,
  type OutgoingMessage,
  type SendResult,
  validateMessage,
} from "mailswitch";
import {
  callProvider,
  classifyResponse,
  discardBody,
  readJson,
  type SendContext,
} from "mailswitch/provider-kit";
```

1. Validate the message first. Return the refusal with no network call.

   ```ts
   const checked = validateMessage(message, lettermillMeta.capabilities);
   if (!checked.ok) return tag(checked.result);
   ```

2. Build the request body once. Convert each `Uint8Array` attachment with `bytesToBase64`. Pass a string attachment through, because it is already base64. Send `message.headers` unchanged.
3. Send the request with `callProvider`. Pass `ctx.fetch` and `ctx.timeoutMs`.

   ```ts
   const call = await callProvider({
     url: `${base}/v1/messages`,
     headers: headers(ctx),
     body: JSON.stringify(lettermillPayload(message)),
     timeoutMs: ctx.timeoutMs,
     fetch: ctx.fetch,
   });
   if (!call.ok) return tag(call.result);
   ```

4. Classify the response with the status map.

   ```ts
   const outcome = classifyResponse(response.status, response.headers, lettermillMeta.statusMap, {
     now: ctx.now,
   });
   ```

5. For `unknown`, release the body and return the result.
6. For `not_sent`, you can read the error code to refine the reason. Keep the fixed message. Never copy the response body into a result.

   ```ts
   function refine(result: NotSentResult, error: LettermillError | null): NotSentResult {
     const code = error?.error?.code;
     const reason = code === "suppressed" ? "rejected" : code === "quota_exceeded" ? "quota" : null;
     if (reason === null) return result;
     return {
       ...result,
       reason,
       message: `The provider answered with HTTP ${result.httpStatus} (${reason}).`,
     };
   }
   ```

7. For a 2xx, read the provider message id and return `sent`.

### Native idempotency

Set `idempotency: true` and `nativeIdempotency: true` only when the provider accepts a key. Then follow these rules:

- Send `message.idempotencyKey` in the provider header. Do not send the header for a message without a key.
- Build the same bytes for the same message, so a retry matches the first request.
- Map the key-conflict response to `unknown`, never to `not_sent`. Add `send.keyConflict` to the fixture.
- If the provider shares the HTTP status of a key conflict with other errors, read the body. Change `not_sent` to `unknown` for a key conflict. Never change `unknown` to `not_sent` from the body.
- If the provider needs a derived key, such as a UUID, derive it from `message.idempotencyKey`. The same key must give the same derived key. Add `expectedIdempotencyKey` to the fixture.
- If the provider takes the key in the body, add `readIdempotencyKey` to the fixture.
- If the provider keeps a key for less than 7 days, set `nativeIdempotencyWindowMs`.

### sendBatch

Add `sendBatch` only when the provider has a batch endpoint. Return one result per message, in the order of the input. A message that `validateMessage` refuses gets its own `not_sent` result. When the whole request fails, give each message the result of that failure. Add `send.batch` to the fixture.

## Write verify

Use the cheapest authenticated read call of the API. It must not send email. Lettermill reads the account:

```ts
async function verify(ctx: SendContext): Promise<VerifyResult> {
  const call = await callProvider({
    url: `${base}/v1/account`,
    method: "GET",
    headers: headers(ctx),
    timeoutMs: ctx.timeoutMs,
    fetch: ctx.fetch,
  });
  if (!call.ok) return { ...tag(call.result), ok: false };
  const outcome = classifyResponse(
    call.response.status,
    call.response.headers,
    lettermillMeta.statusMap,
    { now: ctx.now },
  );
  await discardBody(call.response);
  if (outcome.status === "sent") return { ok: true };
  return { ...tag(outcome), ok: false };
}
```

A wrong key must give `not_sent/auth`. A 5xx and a network error must give `unknown`.

## Webhooks

The webhook router reads the request and calls the adapter. The adapter gives two functions.

```ts
interface ProviderWebhooks {
  verify(input: WebhookVerifyInput): Promise<WebhookVerifyResult>;
  parse(body: Uint8Array, headers: Headers): NormalizedEvent[];
}
```

### Verify rules

- Verify the signature over the raw body bytes in `input.body`. Do not decode the body and encode it again.
- Compare with `hmacVerify`, which uses `crypto.subtle.verify`. Do not compare signature text with `===` or with a loop.
- Refuse an empty secret.
- If the signature covers a timestamp, refuse a timestamp outside the window in both directions, past and future. Use `input.now`, not `Date.now()`.
- Return a typed rejection. Do not throw for a bad request or for a bad secret.
- Decode the body with a fatal `TextDecoder`, so invalid UTF-8 is `malformed`.
- Make no network call, except to fetch a signing certificate (SNS) with `input.fetch`.

| Rejection | When |
|---|---|
| `bad_signature` | The signature is missing or wrong, or the secret is empty. |
| `malformed` | A header or the body cannot be parsed. |
| `stale` | The signed timestamp is outside the window. |
| `invalid_secret` | The secret is set but is too short or has the wrong form. This is a setup error on the receiving side. |

The router sets `too_large`, `body_used`, `replay`, `in_flight`, and `untrusted_topic`.

Lettermill signs `<timestamp>.<raw body>` with HMAC-SHA256:

```ts
async function verifyWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
  if (input.secret === "") return { ok: false, reason: "bad_signature" };
  const timestamp = input.headers.get("lettermill-timestamp");
  const header = input.headers.get("lettermill-signature");
  if (timestamp === null || header === null) return { ok: false, reason: "bad_signature" };
  const match = SIGNATURE.exec(header.trim());
  if (!TIMESTAMP.test(timestamp) || !match) return { ok: false, reason: "malformed" };
  const signed = lettermillSignedPayload(timestamp, input.body);
  if (!(await hmacVerify(input.secret, hexToBytes(match[1] as string), signed))) {
    return { ok: false, reason: "bad_signature" };
  }
  if (Math.abs(input.now - Number(timestamp) * 1000) > LETTERMILL_WEBHOOK_WINDOW_MS) {
    return { ok: false, reason: "stale" };
  }
  const value = decodeJson(input.body);
  if (typeof value !== "object" || value === null) return { ok: false, reason: "malformed" };
  return { ok: true };
}
```

### Parse rules

- Return one `NormalizedEvent` per provider event. A body can hold more than one event.
- Map each provider type to `bounced`, `complained`, `delivered`, or `unsubscribed`. Map every other type to `unknown`. Do not drop it, and do not fail.
- Use `unsubscribed` only when the recipient opted out of all mail from the sender. Map an opt-out from one group or list to `unknown`.
- Set `bounce` to `hard` or `soft` only on a `bounced` event.
- Set `bounceDetail` only on a `bounced` event, and only from fields that the provider sends. Put the reason text in `text`. Set `smtpCode` and `enhancedCode` only when the provider sends them as their own fields. Do not read codes out of the text. Remove control and invisible characters from the text, and cut it at 1,000 characters. The conformance suite fails an event that breaks these rules.
- Set `rawType` to the provider type, exactly.
- Set `provider` to `meta.id`.
- Set `occurredAt` from the provider time, in Unix milliseconds, when the body has one.

### Event keys and dedupe

The router dedupes on `provider:endpointId:eventKey`. The adapter gives the `eventKey`.

- The key is stable across retries of one delivery. Two parses of one body give the same keys.
- The key differs between two real events. A message id plus a type is not enough: it drops a real second soft bounce.
- Use the provider event id when it has one. Lettermill uses `id`.
- When the provider has no event id, use the SHA-256 of the raw body. Add the item index when one body holds many events.
- When the provider signs no timestamp, a replay passes the signature check. Then the dedupe store is the only replay guard. Say so in the provider comments, and set `staleAt: null` in the fixture.

A custom dedupe store can add `claimMany`, `commitMany`, and `releaseMany`. When a store has all three, `handleWebhook` claims and commits the keys of a body in chunks of 500, with one store call for each chunk. The bulk methods must give the same outcome for each key as `claim`, `commit`, and `release`. `claimMany` must claim all keys of a call or none. Test each bulk method against its single method with the same key states. When you subclass `MemoryDedupeStore` or `D1DedupeStore` and override `claim`, `commit`, or `release`, override the matching bulk method too. Otherwise `handleWebhook` calls the bulk method and skips your override.

A custom idempotency store can add `claimMany`, `touchMany`, and `finishMany`, and a custom cap store can add `reserveMany` and `releaseMany`. `sendBatch` uses them when a store has all methods of its group. Each bulk method takes up to 100 inputs and returns one result for each input, in input order. It must give the same results as its single method in a loop, and it must apply all inputs of a call or none. `reserveMany` grants units in order and refuses the rest when the window is full. `sendBatch` uses a bulk method only when the class that defines it also defines the matching single method. So a subclass that overrides only `touch` keeps the per-message path.

## Redaction

The redaction check puts a canary value in each credential field. It runs every failure path through a mock that reflects the whole request: the URL, the headers, and the body. It searches results, `error.stack`, and console output for the canary in raw, base64, hex, URL-encoded, and Basic forms. It also runs every webhook rejection and searches for the webhook secret and the expected signature.

Follow these rules:

- Use the fixed messages of `classifyResponse` and `callProvider`. Never copy a response body, a request header, or a URL with a query into a result.
- Never log a credential. Do not log in the adapter.
- Do not put a credential in a thrown error.
- Send the credentials in the request, so the check can see them.
- If a field `pattern` needs a fixed prefix, give `fixture.canary`. Lettermill keys start with `lm_live_`:

  ```ts
  canary: (_field, token) => `lm_live_${token}`,
  ```

## Record fixtures

A fixture holds recorded provider exchanges. The suite replays them through `ctx.fetch`. No test calls a real provider.

1. Send each request once to the provider with a test account. Use `curl` or the provider API console.
2. Copy the status, the headers that matter (for example `Retry-After`), and the body.
3. Change ids, keys, and addresses to made-up values. Do not commit a real key.
4. Add a comment with the documentation URL and the date of the recording.

If the provider has no test account, copy the examples of its API reference. Say so in the comment.

### The fixture format

The format is `ConformanceFixture` in `src/conformance/types.ts`. Export a function that returns it.

| Field | Required | What it holds |
|---|---|---|
| `credentials` | Yes | Made-up credentials that pass `credentialFields`. |
| `now` | No | A fixed clock in Unix milliseconds. Set it when webhooks sign a timestamp. |
| `send.request` | Yes | The method and the URL of the send call. The URL can be a `RegExp`. |
| `send.success` | Yes | An accepted message. |
| `send.providerMessageId` | No | The id in `send.success`. When set, the result must carry it. |
| `send.authFailure` | Yes | The response to a wrong key. `send.authReason` defaults to `auth`. |
| `send.validationFailure` | Yes | The response to an invalid message. `send.validationReason` defaults to `invalid_message`. |
| `send.serverError` | Yes | A 5xx response. |
| `send.rateLimited` | No | A throttle. The default is a 429 with `Retry-After: 2`. |
| `send.keyConflict` | With native idempotency | The response to a key in use. |
| `send.batch` | With `sendBatch` | The request and the accepted response of a batch. |
| `readHeaders(request)` | With `customHeaders` | Reads the custom headers of the email from a captured request. |
| `readAttachments(request)` | With `attachments` | Reads the attachments (file name and base64 content) from a captured request. |
| `readIdempotencyKey(request)` | No | Reads the idempotency key from a captured request. It returns `undefined` when the request has no key. Give it when the key is in the body. Without it, the kit looks for the key in the request headers. |
| `expectedIdempotencyKey(key)` | No | Returns the key that the adapter must send for a mailswitch key. It can return a promise. Give it when the provider needs a derived key. Without it, the adapter must send the key unchanged. |
| `verify.ok` | Yes | The exchanges of a good key. |
| `verify.badKey` | Yes | The exchanges of a wrong key. `verify.badKeyReason` defaults to `auth`. |
| `webhook` | With `meta.webhooks` | The secret, a `sign` function, `staleAt`, and the samples. |
| `canary` | No | Builds the canary of a credential field. |

A recorded exchange has this shape:

```ts
{
  label: "GET /v1/account with a wrong key",
  method: "GET",
  url: "https://api.lettermill.example/v1/account",
  response: { status: 401, body: { error: { code: "invalid_key" } } },
  times: 1, // optional: answer only this many requests
}
```

- `response` can be `"timeout"` or `"network"` to simulate a transport failure.
- `response` can be a function of the captured request.
- A string `body` is sent as it is. Any other `body` is sent as JSON.

The `webhook` part holds:

| Field | What it holds |
|---|---|
| `secret` | The signing secret. |
| `wrongSecret` | Optional. Defaults to a changed copy of `secret`. |
| `sign({ body, secret, at })` | Signs a body the way the provider does, at time `at`. Reuse the signer of the adapter. |
| `staleAt` | A time outside the signature window. `null` when the provider signs no timestamp. |
| `tamper(body)` | Optional. Changes a signed body. The default changes the first JSON string. |
| `exchanges` | Optional. Exchanges that verification needs, for example a certificate. |
| `samples` | The bodies for `parse`, with the expected events. The first sample is used for the signature checks. |

### The SMTP fixture format

An adapter that sends over SMTP uses `SmtpConformanceFixture`. Set `transport: "smtp"`. The suite runs the adapter against the mock SMTP server through `ctx.connect`, and it makes no HTTP call. The example is `src/conformance/fixtures/smtp.ts`.

| Field | What it holds |
|---|---|
| `credentials` | Valid credentials for the mock server. |
| `server` | The `username` and `password` that the mock server accepts, and optional `authMechanisms`. |
| `replies` | Optional. Recorded replies of the provider: `authFailure`, `recipientRejected`, `rateLimited`, and `afterData`. Each one has a default. |
| `plaintext` | Optional. `true` for a local test server with no TLS. The TLS check is then `n/a`. |
| `providerMessageId` | Optional. The id that a sent result must carry. |
| `canaryCredentials(username, password)` | Builds credentials with a canary login, for the redaction check. |
| `webhook` | The webhook part, as for an HTTP fixture. |

The SMTP checks are in `SMTP_CHECK_IDS`. Three checks are only for SMTP:

- `smtp.before-data`: every failure before the `354` reply to `DATA` gives `not_sent`.
- `smtp.tls`: the adapter sends no `AUTH` line and no message on a plain-text connection.
- `smtp.dot-stuffing`: a line that starts with a dot arrives unchanged.

## Run the conformance suite

The test file is one call:

```ts
import { runConformance } from "mailswitch/conformance/vitest";
import { lettermill } from "./index";
import { lettermillFixture } from "./lettermill.fixture";

runConformance(lettermill(), lettermillFixture(), { tier: 2 });
```

Run it in the repository:

```sh
corepack pnpm exec vitest run test/providers/<id>.conformance.test.ts
```

Run it in a custom project with your own Vitest setup:

```sh
npx vitest run src/email/lettermill/lettermill.conformance.test.ts
```

Each check is one test. A check that does not apply shows as skipped, with the reason. A failure lists each problem as one sentence. Fix the adapter or the fixture, and run the suite again.

`mailswitch/conformance` exports `runChecks`. It runs the same checks with no test framework, on any runtime, and returns a report:

```ts
import { runChecks } from "mailswitch/conformance";

const report = await runChecks({ adapter: lettermill(), fixture: lettermillFixture(), tier: 2 });
console.log(report.ok, report.checks.filter((check) => check.status === "fail"));
```

### The checks

A check is `n/a` only when the meta shows that it does not apply. A missing fixture part is a failure, not a skip.

| Id | What it proves | n/a when |
|---|---|---|
| `declaration` | The meta, the credential fields, and the capabilities are complete. The fixture credentials parse. | Never |
| `declaration.tier` | `meta.tier` equals the declared tier. Each status map entry has a source. Each 5xx gives the status that the tier allows. | Never |
| `send.ok` | An accepted message gives `sent`, with the provider message id. | Never |
| `send.auth` | A wrong key gives `not_sent/auth`. | Never |
| `send.invalid` | A refused message gives `not_sent/invalid_message`. | Never |
| `send.rate-limited` | A throttle gives `not_sent/rate_limited` with `retryAfterMs`. | Never |
| `send.uncertain` | A 5xx, a timeout, and a network error give `unknown`. | Never |
| `send.headers` | Custom headers reach the request unchanged. | `customHeaders` is false |
| `send.idempotency` | The key reaches the request, and a retry sends the same bytes. The kit looks in the headers, or uses `readIdempotencyKey` and `expectedIdempotencyKey`. | No native idempotency |
| `idempotency.conflict` | The key-conflict response gives `unknown`. The status map entry of that HTTP status can be `not_sent` when the adapter reads the body. | No native idempotency |
| `attachments` | The attachment bytes in the request match the input. | `attachments` is false |
| `capability.refuse` | A message that needs a missing capability gives `not_sent/unsupported` with no request. | Every capability is true, with no limits |
| `send.batch` | `sendBatch` returns one result per message, in order. | No `sendBatch` |
| `verify.ok` | Good credentials give `ok: true`. | Never |
| `verify.bad-key` | A wrong key gives `not_sent/auth`. | Never |
| `verify.server-error` | A 503 and a network error give `unknown`. | Never |
| `webhook.valid` | A signed sample passes. | No webhooks |
| `webhook.changed` | A changed body fails. | No webhooks |
| `webhook.wrong-secret` | A wrong secret and an empty secret fail. | No webhooks |
| `webhook.stale` | A stale timestamp fails with `stale`. | No webhooks, or `staleAt` is null |
| `webhook.malformed` | Missing headers, broken headers, and an empty body fail. | No webhooks |
| `events.parse` | Each sample gives the expected events, with stable and unique event keys. | No webhooks |
| `redaction` | No credential or webhook secret reaches a result, an error, or the console. | No secret field and no webhooks |

## Register a built-in provider

A custom provider is done when its suite passes. A built-in provider also needs these changes in the repository:

1. Add the subpath to `exports` in `package.json`, for example `"./lettermill"`.
2. Add the entry to `tsdown.config.ts`.
3. Add a gzip budget to `.size-limit.json`. An HTTP provider starts at 8 KB. When the measured size is over the budget, set the budget to the measured size plus 256 bytes, and say why in the commit message.
4. Add the meta to `catalog` in `src/catalog/index.ts`, and update `test/catalog/catalog.test.ts`.
5. Add a Workers runtime test in `test/workers/<id>.test.ts` that runs `runChecks`.
6. Run every check of the repository:

   ```sh
   corepack pnpm lint
   corepack pnpm typecheck
   corepack pnpm test
   corepack pnpm build
   corepack pnpm size
   ```

## Checklist

Each item names the conformance checks that prove it. An item with no check id needs a review.

- [ ] The id is lowercase and stable, and every file uses it. (`declaration`)
- [ ] `meta.ts` holds only data and imports only core data modules. (catalog test)
- [ ] The credential fields have labels, `secret` flags, at least one required field, and anchored patterns. The fixture credentials pass them. (`declaration`)
- [ ] The capabilities match the provider documentation. `nativeIdempotency` equals `capabilities.idempotency`. (`declaration`, `capability.refuse`)
- [ ] `meta.tier` equals the tier in the test call. (`declaration.tier`)
- [ ] Each status map entry has a source URL. A tier 2 provider keeps every 5xx `unknown`. (`declaration.tier`)
- [ ] Every HTTP call goes through `ctx.fetch` with `callProvider`. (`send.uncertain`, `verify.server-error`)
- [ ] `send` validates the message before any request. (`capability.refuse`)
- [ ] `send` maps 2xx, auth, validation, throttle, 5xx, timeout, and network outcomes. (`send.ok`, `send.auth`, `send.invalid`, `send.rate-limited`, `send.uncertain`)
- [ ] Custom headers and attachment bytes reach the request unchanged. (`send.headers`, `attachments`)
- [ ] With native idempotency: the key is sent, a retry sends the same bytes, and a key conflict is `unknown`. (`send.idempotency`, `idempotency.conflict`)
- [ ] With `sendBatch`: one result per message, in order. (`send.batch`)
- [ ] `verify` sends no email and maps a wrong key to `not_sent/auth`. (`verify.ok`, `verify.bad-key`, `verify.server-error`)
- [ ] With webhooks: the signature is checked over raw bytes with `hmacVerify`, and every bad request gets a typed rejection. (`webhook.valid`, `webhook.changed`, `webhook.wrong-secret`, `webhook.stale`, `webhook.malformed`)
- [ ] With webhooks: each event has a stable, unique event key, and unmapped types are `unknown`. (`events.parse`)
- [ ] No credential or secret reaches a result, an error, or a log. (`redaction`)
- [ ] Each fixture has made-up ids and keys, a source URL, and a date.
- [ ] No `TODO(scaffold)` or `SCAFFOLD STUB` is left.
- [ ] The conformance test passes at the declared tier.
- [ ] For a built-in provider: the export, the build entry, the size budget, the catalog entry, and the Workers test are added. Lint, typecheck, test, build, and size pass.
