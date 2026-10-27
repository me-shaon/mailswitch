# Generic HTTP provider

Last checked: 2026-10-27

The generic HTTP provider is in `mailswitch/http`. Use it for a simple JSON email API that mailswitch does not ship. It is a tier 2 provider. It sends email with attachments, and it checks the token. It does not read webhooks.

The provider has two APIs. Both give the same adapter, with the same safety rules.

| API | Use it for |
|---|---|
| `httpProviderFromConfig(config, { allowHosts })` | A JSON config, for example from a settings screen. It needs no adapter code. |
| `httpProvider(options)` | Code that builds each request. Use it when a field map is not enough. |

For an API that needs more than this, write a custom adapter. See [Add a provider](../guides/add-a-provider.md).

## Safety rules

Code enforces these rules. No option and no config can change them.

- No status can map a 5xx, a 3xx, a 408, or a 409 to `not_sent`. A timeout and a transport error are always `unknown`.
- Every request goes to an `https` host that passes the host rules. This applies to send and to verify.
- No request follows a redirect. Each call sets `redirect: "manual"`, and a 3xx is `unknown`.
- The JSON config API requires `allowHosts`.

## JSON config API

```ts
import { httpProviderFromConfig, type HttpProviderConfig } from "mailswitch/http";

declare const storedConfig: HttpProviderConfig;

const adapter = httpProviderFromConfig(storedConfig, {
  allowHosts: ["api.mail.example"],
});
```

A config example:

```ts
import type { HttpProviderConfig } from "mailswitch/http";

const config: HttpProviderConfig = {
  id: "examplemail",
  name: "Example Mail",
  endpoint: "https://api.mail.example/v1/send",
  method: "POST",
  auth: { type: "bearer" },
  fields: {
    from: "from",
    to: "to",
    cc: "cc",
    bcc: "bcc",
    replyTo: "reply_to",
    subject: "subject",
    html: "html",
    text: "text",
    headers: "headers",
    attachments: "attachments",
  },
  attachmentFields: { filename: "name", content: "data", contentType: "type", contentId: "cid" },
  addressFormat: "object",
  idFrom: "data.messageId",
  verify: { endpoint: "https://api.mail.example/v1/account", method: "GET" },
  notSentStatuses: [404],
  unknownStatuses: [422],
};
```

### Config keys

The schema is closed. The adapter refuses a key that the schema does not name, at every level. So a secret cannot sit in the config.

| Key | Required | Rule |
|---|---|---|
| `id` | Yes | A lowercase letter, then 1 to 31 lowercase letters, digits, or hyphens. It must not be the id of a built-in provider. |
| `name` | Yes | The name that a user sees. |
| `endpoint` | Yes | The https URL of the send call. See [Host rules](#host-rules). It must have no query string, no fragment, and no user name or password. |
| `method` | No | `POST` or `PUT`. The default is `POST`. |
| `auth` | Yes | How the request carries the token. See [Auth](#auth). |
| `fields` | Yes | The field map. See [Field map](#field-map). |
| `attachmentFields` | No | The keys of one attachment object. |
| `addressFormat` | No | `object` or `string`. The default is `object`. |
| `idFrom` | No | A dot path to the message id in the JSON answer, for example `data.messageId` or `ids.0`. When it is set, a 2xx with no id is `unknown`. |
| `verify` | Yes | `{ endpoint, method }`. A request that checks the token and sends no email. `method` is `GET` or `POST`. The default is `GET`. The verify request has no body. |
| `requestHeaders` | No | Static request headers. A header that carries auth is refused. |
| `notSentStatuses` | No | More 4xx codes that mean "not sent". See [Delivery status](#delivery-status). |
| `unknownStatuses` | No | 4xx codes that mean "may have sent". |

A bad config throws a `TypeError` at setup. The error names the field. It never holds a URL, a key name, or a value.

### Auth

The token comes from the credential field `token`. It never goes in the config.

| `auth` | The request header |
|---|---|
| `{ "type": "bearer" }` | `Authorization: Bearer <token>` |
| `{ "type": "header", "header": "X-Mail-Token" }` | `X-Mail-Token: <token>` |
| `{ "type": "basic", "username": "api" }` | HTTP Basic auth. The user name comes from the config. The password is the token. |

The `auth` block takes no other key. A `token`, a `password`, or a `value` key is refused.

`requestHeaders` refuses a header name that looks like auth. It cannot set `Authorization`, `Proxy-Authorization`, `X-Api-Key`, `Api-Key`, `X-Auth-Token`, or `Cookie`. It also refuses a header name with the words `auth`, `token`, `key`, `secret`, `pass`, `session`, `cookie`, `signature`, `credential`, or `bearer`, and the auth header of the config. A header value must not hold a secret, because the config is not secret. Put the secret in the `token` credential.

### Field map

The field map names the body key of each message part. The request body is one JSON object. The adapter evaluates no expression and renders no template.

| Field | Required | Value in the body |
|---|---|---|
| `from` | Yes | One address. |
| `to` | Yes | An array of addresses. |
| `subject` | Yes | The subject text. |
| `attachments` | Yes | An array of attachment objects. Tier 2 needs attachments. |
| `cc`, `bcc` | No | An array of addresses. |
| `replyTo` | No | One address. |
| `html`, `text` | No | The body text. |
| `headers` | No | An object with the custom headers of the message, unchanged. |

A key is 1 to 64 letters, digits, `_`, `$`, or `-`. It starts with a letter, `_`, or `$`. Two fields cannot use the same key.

A part goes in the body only when the field map names it and the message has it. The adapter sets `cc`, `bcc`, `replyTo`, and `customHeaders` in its capabilities only when the field map names them. So a message with Cc and no `cc` field is refused as `not_sent/unsupported`, before any request. A message with an HTML body and no `html` field is refused the same way. So is a message with a text body and no `text` field.

The address format:

| `addressFormat` | Value |
|---|---|
| `object` | `{ "email": "ana@example.org", "name": "Ana" }`. `name` is left out when it is empty. |
| `string` | `"Ana <ana@example.org>"`. A name with a special character is in double quotes. |

An attachment object has four keys. The `attachmentFields` map changes their names.

| Key | Default name | Value |
|---|---|---|
| `filename` | `filename` | The file name. |
| `content` | `content` | The content as base64 text. |
| `contentType` | `contentType` | The MIME type. |
| `contentId` | `contentId` | Only for an inline attachment. |

## Code API

```ts
import { httpProvider } from "mailswitch/http";

const adapter = httpProvider({
  id: "acme-mail",
  name: "Acme Mail",
  credentialFields: [{ name: "apiKey", label: "API key", secret: true, required: true }],
  capabilities: {
    attachments: true,
    maxMessageBytes: 10_000_000,
    cc: true,
    bcc: true,
    replyTo: false,
    customHeaders: false,
  },
  buildRequest: (message, ctx) => ({
    url: "https://api.acme.example/v2/messages",
    headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
    body: { sender: message.from, recipients: message.to, title: message.subject },
  }),
  verifyRequest: (ctx) => ({
    url: "https://api.acme.example/v2/me",
    headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
  }),
  idFrom: "message.id",
  allowHosts: ["api.acme.example"],
});
```

| Option | Required | Use |
|---|---|---|
| `id`, `name` | Yes | The provider id and the display name. The id follows the rule of the config `id`. |
| `credentialFields` | Yes | The credential form. At least one field is a required secret. |
| `capabilities` | Yes | What the API can send. `attachments` must be `true`. The adapter sets `idempotency: false` and `batchSize: 1`. |
| `buildRequest(message, ctx)` | Yes | Returns `{ url, method, headers, body }`. `ctx.credentials` holds the parsed credentials. |
| `verifyRequest(ctx)` | Yes | Returns the request of a check that sends no email. |
| `idFrom` | No | A dot path into the JSON answer, or a function of the body and the headers. When it is set, a 2xx with no id is `unknown`. |
| `classify` | No | A hook that changes the table result. See [The classify hook](#the-classify-hook). |
| `notSentStatuses`, `unknownStatuses` | No | As in the config. |
| `allowHosts` | No | The hosts that a request can reach. Set it when you can. |
| `docsUrl` | No | The docs of the API. |

The method is `GET`, `HEAD`, `POST`, `PUT`, or `PATCH`. Send uses `POST` by default, and verify uses `GET`. A string body or a byte body goes as it is. An object or an array goes as JSON, with `content-type: application/json` when the headers do not set it. A body with `GET` or `HEAD` is refused.

The code API checks the host rules at send time, because the URL comes from `buildRequest`. A URL that breaks a rule gives `not_sent/unsupported`, with no fetch. A code-API URL can have a query string. It cannot have a user name or a password.

A `buildRequest` that throws, or that returns a bad request, gives `not_sent/invalid_message` with no fetch. The result never holds the error text.

## Host rules

Each request URL must pass these rules, for send and for verify:

1. The URL parses, and its protocol is `https:`.
2. The URL has no user name and no password, and no space or control character.
3. The host is not an IPv6 literal, such as `[::1]`.
4. The host is not an IPv4 address in any form: dotted (`127.0.0.1`), short (`127.1`), decimal (`2130706433`), hex (`0x7f000001`), or octal (`0177.0.0.1`).
5. The host is lowercased, and one trailing dot is removed. Then `localhost`, `*.localhost`, `*.local`, `*.internal`, and a name with one label are refused.
6. A port other than 443 needs an `allowHosts` entry that names it, as `host:port`.
7. When `allowHosts` is set, the host must match one entry exactly. A subdomain does not match its parent.

`allowHosts` entries are normalized the same way. An empty list, a `*` entry, and an entry that breaks a rule throw a `TypeError` at setup. The loopback exception that some adapters have for tests does not apply to this provider.

`allowHosts` must come from the deployer, for example from code or from an env var. It must never come from the same input as the config. A settings screen that takes the endpoint from a user must not take the allowlist from that user too. Workers cannot pin DNS, so the allowlist is the main control against a request to an internal host.

## Delivery status

The provider has its own base table, because its endpoint has no researched docs.

| Answer | Status and reason |
|---|---|
| 2xx, with `idFrom` set and an id at `idFrom` | `sent`, with the id |
| 2xx, with `idFrom` set and no id, or a body that cannot be read | `unknown/provider_error`, with `httpStatus` |
| 2xx, with no `idFrom` | `sent`, with no message id |
| 400, 413, 415, 422 | `not_sent/invalid_message` |
| 401, 403 | `not_sent/auth` |
| 402 | `not_sent/credits` |
| 429 | `not_sent/rate_limited`, with `retryAfterMs` from `Retry-After` |
| A code in `notSentStatuses` | `not_sent/rejected` |
| A code in `unknownStatuses` | `unknown/provider_error` |
| Every other 4xx, for example 404, 408, 409, and 499 | `unknown/provider_error` |
| Every 3xx | `unknown/provider_error` |
| Every 5xx, and any code outside 200 to 599 | `unknown/provider_error` |
| Timeout or network error | `unknown` |

When you set `idFrom`, a 2xx must carry a message id. A 2xx with an empty body, a body that is not JSON, or a blank id at `idFrom` is `unknown`, because the answer may hide a failure. A function `idFrom` that throws or returns no id gives `unknown` too. When you do not set `idFrom`, a 2xx is `sent` with no message id, whatever the body holds. The adapter never invents a message id.

The adapter reads at most 64 KiB of a response body. When the `content-length` header is larger, the adapter cancels the body and does not read it. When a body grows past 64 KiB as it streams, the adapter cancels it. The adapter cannot read such a body. On a 2xx with `idFrom`, the result is `unknown`. On any other status, the `classify` hook gets `null` as the body, and the status table gives the result.

Note that 404 is `unknown` here, and `not_sent/rejected` in the default table of other adapters. An unknown API can answer 404 for a missing route after a proxy sent the request on.

The two lists change the table:

- `unknownStatuses` moves any 4xx code to `unknown`. Use it for an API that answers a 4xx for a duplicate or a conflict, where the first request may have sent.
- `notSentStatuses` adds 4xx codes as `not_sent/rejected`. Add a code only when the API docs say that it means "not sent". An entry of 408, 409, or a code outside 400 to 499 throws a `TypeError` at setup.
- A code cannot be in both lists.

Unknown statuses take precedence over the base table. A result message holds the HTTP status and the reason. It never holds the response body, the URL, or a header.

### The classify hook

The code API takes an optional `classify` hook. It gets `{ operation, status, headers, body }`, where `body` is the parsed JSON, or `null` for an empty body, a body that is not JSON, or a body that the adapter cannot read. It returns `{ status: "sent" }`, `{ status: "not_sent", reason }`, `{ status: "unknown" }`, or `undefined` to keep the table result.

The hook answers within the same rules:

- `not_sent` is allowed only for a 4xx code that is not 408, not 409, and not in `unknownStatuses`. For any other code, the answer becomes `unknown`.
- `sent` is allowed only for a 2xx. For any other code, the answer becomes `unknown`.
- The `not_sent` reason is one of `auth`, `rate_limited`, `quota`, `credits`, `rejected`, and `invalid_message`. Any other reason becomes `unknown`.
- A hook that throws, or that returns another shape, gives `unknown`.

```ts
import { httpProvider } from "mailswitch/http";

declare const base: Parameters<typeof httpProvider>[0];

const adapter = httpProvider({
  ...base,
  classify: ({ status, body }) => {
    const code = (body as { code?: string } | null)?.code;
    if (status === 404 && code === "suppressed") return { status: "not_sent", reason: "rejected" };
    return undefined;
  },
});
```

### Fallback

No 5xx of an unknown API proves that nothing went out. So every 5xx is `unknown`, as tier 2 requires. Do not retry and do not fall back after `unknown`. Because of this, a fallback to the next provider rarely occurs after a failure of this provider. A fallback occurs only after a `not_sent` result, for example a bad token, a refused message, or a throttle.

### Verify

Verify sends the configured request with the token. It uses the same host rules and the same table.

| Answer | Verify result |
|---|---|
| 2xx | `ok` |
| 401 or 403 | `not_sent/auth` |
| Other 4xx | The result of the table |
| 3xx | `unknown`. No redirect is followed. |
| Any 5xx, a timeout, or a network error | `unknown` |

## Settings screens

The catalog has one entry, `http`. It describes only the credential form of the JSON config API: one secret field, `token`. It does not describe the capabilities of a built adapter.

- Store the JSON config outside the credentials, for example in its own settings table.
- Send the token through the normal credential flow, with the fields of `getProviderMeta("http")`.
- Use `config.id` for scopes, daily caps, and stored credentials.
- `getProviderMeta(config.id)` finds nothing. Use `adapter.meta` of the built adapter.

```ts
import { getProviderMeta } from "mailswitch/catalog";
import { httpProviderFromConfig, type HttpProviderConfig } from "mailswitch/http";

declare const env: { MAIL_ALLOW_HOSTS: string };
declare const storedConfig: HttpProviderConfig;

const tokenForm = getProviderMeta("http")?.credentialFields;
const adapter = httpProviderFromConfig(storedConfig, {
  allowHosts: env.MAIL_ALLOW_HOSTS.split(","),
});
const scope = adapter.meta.id;
```

## Tests

The provider has no live smoke test, because it has no fixed endpoint. Its gate is the conformance suite, which runs at tier 2 against a sample config at `mail.example.test`. The suite includes the redaction check. Every call of the suite carries `redirect: "manual"`.

Test your own config with the conformance kit and recorded answers of your API. See [Run the conformance suite](../guides/add-a-provider.md#run-the-conformance-suite).

## Webhooks

The generic provider does not read webhooks. `meta.webhooks` is `false`.
