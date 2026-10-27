// The JSON config API of the generic HTTP provider. A settings screen can store the
// config as JSON and build the adapter from it, with no adapter code. The config is
// checked once, at setup. A bad config throws a TypeError that names the field and never
// holds a value.
//
// - The config has a closed schema. An unknown key is refused at every level, so a secret
//   cannot sit in the config. The token comes from the credential field `token`.
// - A field map names the body key of each message part. No expression is ever
//   evaluated.
// - `endpoint` and `verify.endpoint` follow the host rules, with no query string, no
//   fragment, and no userinfo. Each host must be in `allowHosts`, which comes from the
//   deployer.

import type { ProviderAdapter } from "../../core/adapter";
import { defineStatusMap } from "../../core/classify";
import { defineProviderMeta } from "../../core/meta";
import type { AddressInput, OutgoingMessage } from "../../core/types";
import { addressObject, formatAddress, hasForbiddenChars } from "../../internal/address";
import { attachmentBase64, basicAuthorization } from "../../internal/encoding";
import { asRecord } from "../../internal/json";
import {
  checkProviderId,
  checkProviderName,
  createHttpAdapter,
  type HttpRequest,
  type HttpRequestContext,
  isIdPath,
} from "./adapter";
import { parseStatusRules } from "./classify";
import { checkRequestUrl, describeBreak, parseAllowHosts, type UrlRuleOptions } from "./hosts";
import { HTTP_DOCS_URL, httpMeta } from "./meta";

/** The body keys of the message parts. `from`, `to`, `subject`, and `attachments` are required. */
export interface HttpFieldMap {
  from: string;
  to: string;
  subject: string;
  /** Tier 2 needs attachments, so this key is required. */
  attachments: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  html?: string;
  text?: string;
  /** The key of an object with the custom headers of the message. */
  headers?: string;
}

/** The keys of one attachment object. Each key has the default in its name. */
export interface HttpAttachmentFieldMap {
  /** Defaults to `filename`. */
  filename?: string;
  /** The base64 content. Defaults to `content`. */
  content?: string;
  /** Defaults to `contentType`. */
  contentType?: string;
  /** Set only for an inline attachment. Defaults to `contentId`. */
  contentId?: string;
}

/**
 * How the request carries the `token` credential. The schema is closed: no other key is
 * allowed, so the config cannot hold a secret.
 * - `bearer`: `Authorization: Bearer <token>`.
 * - `header`: `<header>: <token>`.
 * - `basic`: HTTP Basic auth, with `username` from the config and the token as the password.
 */
export type HttpAuthConfig =
  | { type: "bearer" }
  | { type: "header"; header: string }
  | { type: "basic"; username: string };

/** The JSON config of one generic HTTP adapter. */
export interface HttpProviderConfig {
  /** The provider id. It must not be the id of a built-in provider. Scopes and caps use it. */
  id: string;
  name: string;
  /** The https URL of the send call, with no query string. */
  endpoint: string;
  /** Defaults to `POST`. */
  method?: "POST" | "PUT";
  auth: HttpAuthConfig;
  fields: HttpFieldMap;
  attachmentFields?: HttpAttachmentFieldMap;
  /** `object` sends `{ email, name }`. `string` sends `Name <email>`. Defaults to `object`. */
  addressFormat?: "object" | "string";
  /** A dot path to the message id in the JSON answer, for example `data.messageId`. */
  idFrom?: string;
  /** A request that checks the token and sends no email. */
  verify: { endpoint: string; method?: "GET" | "POST" };
  /** Static request headers. A header that carries auth is refused. */
  requestHeaders?: Readonly<Record<string, string>>;
  /** More 4xx codes that mean "not sent". Never 408 or 409. */
  notSentStatuses?: readonly number[];
  /** 4xx codes that mean "may have sent", for example a duplicate or a conflict. */
  unknownStatuses?: readonly number[];
}

/** The options of `httpProviderFromConfig`. They come from the deployer, not from the config. */
export interface HttpConfigOptions {
  /** The hosts that the config may name, as `host` or `host:port`. Required. */
  allowHosts: readonly string[];
}

/** Static header names that carry auth. A config cannot set them. */
export const HTTP_AUTH_HEADERS: readonly string[] = Object.freeze([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "cookie",
]);

// A static header name with one of these words probably carries a secret too.
const SECRET_WORDS = /auth|token|key|secret|password|session|cookie/i;
// Headers that the transport sets. A config cannot set them.
const TRANSPORT_HEADERS: readonly string[] = ["host", "content-length", "transfer-encoding"];

const LABEL = "httpProviderFromConfig";
const KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];
const TOP_KEYS: readonly string[] = [
  "id",
  "name",
  "endpoint",
  "method",
  "auth",
  "fields",
  "attachmentFields",
  "addressFormat",
  "idFrom",
  "verify",
  "requestHeaders",
  "notSentStatuses",
  "unknownStatuses",
];
const FIELD_KEYS: readonly string[] = [
  "from",
  "to",
  "subject",
  "attachments",
  "cc",
  "bcc",
  "replyTo",
  "html",
  "text",
  "headers",
];
const REQUIRED_FIELDS: readonly string[] = ["from", "to", "subject", "attachments"];
const ATTACHMENT_DEFAULTS = {
  filename: "filename",
  content: "content",
  contentType: "contentType",
  contentId: "contentId",
} as const;

function fail(field: string, text: string): never {
  throw new TypeError(`${LABEL}: ${field === "" ? "config" : `config.${field}`} ${text}`);
}

/** The value as a plain object with only the allowed keys. */
function closed(
  value: unknown,
  field: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) fail(field, "must be an object.");
  for (const key of Object.keys(record)) {
    // The key is not echoed: a misplaced secret could be a key.
    if (!allowed.includes(key)) fail(field, "has a key that the schema does not allow.");
  }
  return record;
}

function bodyKey(value: unknown, field: string): string {
  if (typeof value !== "string" || !KEY.test(value) || RESERVED_KEYS.includes(value)) {
    fail(field, "must be a key of 1 to 64 letters, digits, _, $, or -.");
  }
  return value;
}

function checkUrl(value: unknown, field: string, rules: UrlRuleOptions): string {
  const checked = checkRequestUrl(value, rules);
  if (!checked.ok)
    throw new TypeError(`${LABEL}: ${describeBreak(`config.${field}`, checked.rule)}`);
  return checked.url.href;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], def: T): T {
  if (value === undefined) return def;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(field, `must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function headerName(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEADER_NAME.test(value)) fail(field, "must be a header name.");
  const lower = value.toLowerCase();
  if (TRANSPORT_HEADERS.includes(lower) || lower === "content-type") {
    fail(field, "names a header that the transport sets.");
  }
  return lower;
}

/** The auth header of a token. The token never goes in the config. */
type AuthHeader = (token: string) => [name: string, value: string];

function checkAuth(value: unknown): { header: AuthHeader; name: string } {
  const record = asRecord(value);
  if (!record) fail("auth", "must be an object.");
  if (record.type === undefined) fail("auth.type", "is required.");
  const type = oneOf(record.type, "auth.type", ["bearer", "header", "basic"] as const, "bearer");
  if (type === "bearer") {
    closed(record, "auth", ["type"]);
    return { name: "authorization", header: (token) => ["authorization", `Bearer ${token}`] };
  }
  if (type === "header") {
    closed(record, "auth", ["type", "header"]);
    const name = headerName(record.header, "auth.header");
    return { name, header: (token) => [name, token] };
  }
  closed(record, "auth", ["type", "username"]);
  const username = record.username;
  if (
    typeof username !== "string" ||
    username === "" ||
    username.length > 256 ||
    username.includes(":") ||
    hasForbiddenChars(username)
  ) {
    fail("auth.username", "must be a user name of 1 to 256 characters with no colon.");
  }
  return {
    name: "authorization",
    header: (token) => ["authorization", basicAuthorization(username, token)],
  };
}

function checkFieldMap(value: unknown): HttpFieldMap {
  const record = closed(value, "fields", FIELD_KEYS);
  for (const key of REQUIRED_FIELDS) {
    if (record[key] === undefined) fail(`fields.${key}`, "is required.");
  }
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const key of FIELD_KEYS) {
    if (record[key] === undefined) continue;
    const target = bodyKey(record[key], `fields.${key}`);
    if (used.has(target)) fail(`fields.${key}`, "uses a key that another field uses.");
    used.add(target);
    out[key] = target;
  }
  return out as unknown as HttpFieldMap;
}

function checkAttachmentMap(value: unknown): Required<HttpAttachmentFieldMap> {
  if (value === undefined) return { ...ATTACHMENT_DEFAULTS };
  const record = closed(value, "attachmentFields", Object.keys(ATTACHMENT_DEFAULTS));
  const out = { ...ATTACHMENT_DEFAULTS } as Record<keyof HttpAttachmentFieldMap, string>;
  const used = new Set<string>();
  for (const key of Object.keys(ATTACHMENT_DEFAULTS) as (keyof HttpAttachmentFieldMap)[]) {
    if (record[key] !== undefined) out[key] = bodyKey(record[key], `attachmentFields.${key}`);
    if (used.has(out[key])) fail(`attachmentFields.${key}`, "uses a key that another field uses.");
    used.add(out[key]);
  }
  return out;
}

function checkRequestHeaders(value: unknown, authName: string): [string, string][] {
  if (value === undefined) return [];
  const record = asRecord(value);
  if (!record) fail("requestHeaders", "must be an object.");
  const out: [string, string][] = [];
  for (const [name, header] of Object.entries(record)) {
    // The name is not echoed: a misplaced secret could be a name.
    const lower = typeof name === "string" && HEADER_NAME.test(name) ? name.toLowerCase() : "";
    if (lower === "") fail("requestHeaders", "has a name that is not a header name.");
    if (HTTP_AUTH_HEADERS.includes(lower) || SECRET_WORDS.test(lower) || lower === authName) {
      fail(
        "requestHeaders",
        "has a header that carries auth. Put the secret in the token credential.",
      );
    }
    if (TRANSPORT_HEADERS.includes(lower)) {
      fail("requestHeaders", "has a header that the transport sets.");
    }
    if (typeof header !== "string" || header.length > 1024 || hasForbiddenChars(header)) {
      fail("requestHeaders", "has a value that is not a header value.");
    }
    out.push([lower, header]);
  }
  return out;
}

/**
 * Builds the JSON body of one message from the field map. Each optional part goes only
 * when the field map names it and the message has it.
 */
function buildBody(
  message: OutgoingMessage,
  fields: HttpFieldMap,
  attachment: Required<HttpAttachmentFieldMap>,
  asString: boolean,
): Record<string, unknown> {
  const address = (input: AddressInput) =>
    asString ? formatAddress(addressObject(input)) : addressObject(input);
  const body: Record<string, unknown> = {};
  body[fields.from] = address(message.from);
  body[fields.to] = message.to.map(address);
  if (fields.cc !== undefined && message.cc?.length) body[fields.cc] = message.cc.map(address);
  if (fields.bcc !== undefined && message.bcc?.length) body[fields.bcc] = message.bcc.map(address);
  if (fields.replyTo !== undefined && message.replyTo !== undefined) {
    body[fields.replyTo] = address(message.replyTo);
  }
  body[fields.subject] = message.subject;
  if (fields.html !== undefined && message.html !== undefined) body[fields.html] = message.html;
  if (fields.text !== undefined && message.text !== undefined) body[fields.text] = message.text;
  const headers = Object.entries(message.headers ?? {});
  if (fields.headers !== undefined && headers.length > 0) {
    body[fields.headers] = Object.fromEntries(headers);
  }
  if (message.attachments?.length) {
    body[fields.attachments] = message.attachments.map((item) => {
      const entry: Record<string, string> = {};
      entry[attachment.filename] = item.filename;
      entry[attachment.content] = attachmentBase64(item);
      entry[attachment.contentType] = item.contentType;
      if (item.contentId !== undefined) entry[attachment.contentId] = item.contentId;
      return entry;
    });
  }
  return body;
}

/**
 * Creates a generic HTTP adapter from a JSON config. The config is checked at setup,
 * with the host rules for `endpoint` and `verify.endpoint`. The token comes from the
 * credential field `token`.
 *
 * Store the config outside the credentials, for example in a settings table. Scopes,
 * caps, and stored credentials use `config.id`.
 *
 * @param options.allowHosts The hosts that the config may name. It comes from the
 * deployer, never from the same input as the config.
 * @throws TypeError for a bad config or a missing `allowHosts`. The error names the
 * field and never holds a value.
 */
export function httpProviderFromConfig(
  config: HttpProviderConfig,
  options: HttpConfigOptions,
): ProviderAdapter {
  if (asRecord(options) === undefined || options.allowHosts === undefined) {
    throw new TypeError(`${LABEL}: options.allowHosts is required. The deployer sets it.`);
  }
  const allowHosts = parseAllowHosts(options.allowHosts, `${LABEL}: options.allowHosts`);
  const record = closed(config, "", TOP_KEYS);
  const id = checkProviderId(record.id, `${LABEL}: config.id`);
  const name = checkProviderName(record.name, `${LABEL}: config.name`);
  const urlRules: UrlRuleOptions = { allowHosts, refuseQuery: true };
  const endpoint = checkUrl(record.endpoint, "endpoint", urlRules);
  const method = oneOf(record.method, "method", ["POST", "PUT"] as const, "POST");
  const auth = checkAuth(record.auth);
  const fields = checkFieldMap(record.fields);
  const attachment = checkAttachmentMap(record.attachmentFields);
  const format = oneOf(
    record.addressFormat,
    "addressFormat",
    ["object", "string"] as const,
    "object",
  );
  const idFrom = record.idFrom;
  if (idFrom !== undefined && !isIdPath(idFrom)) fail("idFrom", "must be a dot path.");
  const verify = closed(record.verify, "verify", ["endpoint", "method"]);
  const verifyEndpoint = checkUrl(verify.endpoint, "verify.endpoint", urlRules);
  const verifyMethod = oneOf(verify.method, "verify.method", ["GET", "POST"] as const, "GET");
  const staticHeaders = checkRequestHeaders(record.requestHeaders, auth.name);
  const rules = parseStatusRules(
    record.notSentStatuses,
    record.unknownStatuses,
    `${LABEL}: config.`,
  );

  const meta = defineProviderMeta({
    id,
    name,
    tier: 2,
    capabilities: {
      ...httpMeta.capabilities,
      cc: fields.cc !== undefined,
      bcc: fields.bcc !== undefined,
      replyTo: fields.replyTo !== undefined,
      customHeaders: fields.headers !== undefined,
    },
    credentialFields: httpMeta.credentialFields,
    docsUrl: HTTP_DOCS_URL,
    statusMap: defineStatusMap({}),
    webhooks: false,
    nativeIdempotency: false,
  });

  function headers(ctx: HttpRequestContext, json: boolean): Record<string, string> {
    const out: Record<string, string> = { accept: "application/json" };
    if (json) out["content-type"] = "application/json";
    for (const [key, value] of staticHeaders) out[key] = value;
    // The auth header goes last, so no static header can replace it.
    const [key, value] = auth.header((ctx.credentials.token ?? "").trim());
    out[key] = value;
    return out;
  }

  function buildRequest(message: OutgoingMessage, ctx: HttpRequestContext): HttpRequest {
    return {
      url: endpoint,
      method,
      headers: headers(ctx, true),
      body: JSON.stringify(buildBody(message, fields, attachment, format === "string")),
    };
  }

  function verifyRequest(ctx: HttpRequestContext): HttpRequest {
    return { url: verifyEndpoint, method: verifyMethod, headers: headers(ctx, false) };
  }

  function refuse(message: OutgoingMessage): string | null {
    if (message.html !== undefined && fields.html === undefined) {
      return "The config maps no html field, so the HTML body cannot go.";
    }
    if (message.text !== undefined && fields.text === undefined) {
      return "The config maps no text field, so the text body cannot go.";
    }
    return null;
  }

  return createHttpAdapter({
    meta,
    rules,
    urlRules,
    buildRequest,
    verifyRequest,
    refuse,
    idFrom: idFrom as string | undefined,
  });
}
