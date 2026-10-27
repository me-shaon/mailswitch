// The engine of the generic HTTP provider. The code API and the JSON config API both build
// their adapter here, so both follow the same host rules and the same status rules.
// Internal to the provider.
//
// Each request:
// 1. The message passes `validateMessage` and the refusal check of the API.
// 2. The API builds the request. A build that throws or returns a bad request is
//    `not_sent/invalid_message`, with no fetch.
// 3. The URL passes the host rules, or the result is `not_sent/unsupported`, with no fetch.
// 4. `callProvider` sends it with `redirect: "manual"`. A timeout or a thrown fetch is
//    `unknown`, with a message that holds no URL.
// 5. `classifyHttp` classifies the status, with the hook answer when there is a hook.

import {
  defineProvider,
  type ProviderAdapter,
  type ProviderCredentials,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { validateMessage } from "../../core/message";
import type { ProviderMeta } from "../../core/meta";
import type { FailureReason, NotSentResult, OutgoingMessage, SendResult } from "../../core/types";
import { hasForbiddenChars } from "../../internal/address";
import { callProvider, discardBody, readJson } from "../../internal/http";
import {
  classifyHttp,
  type HttpClassifyAnswer,
  type HttpStatusRules,
  sentResult,
  transportOutcome,
} from "./classify";
import { checkRequestUrl, describeBreak, type UrlRuleOptions } from "./hosts";

/** The request methods that the generic provider sends. */
export const HTTP_METHODS: readonly string[] = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
]);

/** The body of a request. An object or an array is sent as JSON. */
export type HttpRequestBody =
  | string
  | Uint8Array<ArrayBuffer>
  | Readonly<Record<string, unknown>>
  | readonly unknown[]
  | null;

/** One request of the generic provider. */
export interface HttpRequest {
  /** An https URL that passes the host rules. */
  url: string;
  /** One of `GET`, `HEAD`, `POST`, `PUT`, and `PATCH`. Send defaults to `POST`, verify to `GET`. */
  method?: string;
  headers?: Readonly<Record<string, string>>;
  /** A string or bytes go as they are. An object or an array goes as JSON. */
  body?: HttpRequestBody;
}

/** What `buildRequest` and `verifyRequest` get. */
export interface HttpRequestContext {
  /** The parsed credentials, by field name. */
  credentials: ProviderCredentials;
  /** The current time, in Unix milliseconds. */
  now: number;
}

/** What a `classify` hook gets. */
export interface HttpClassifyInput {
  operation: "send" | "verify";
  status: number;
  headers: Headers;
  /** The parsed JSON body, or null for an empty or a non-JSON body. */
  body: unknown;
}

/** A `classify` hook. Return undefined to keep the result of the base table. */
export type HttpClassifyHook = (input: HttpClassifyInput) => HttpClassifyAnswer | undefined;

/** Reads the provider message id: a dot path into the JSON body, or a function. */
export type HttpIdFrom = string | ((body: unknown, headers: Headers) => string | undefined);

/** The spec of one adapter, after the API checked its options. */
export interface HttpEngineSpec {
  meta: ProviderMeta;
  rules: HttpStatusRules;
  urlRules: UrlRuleOptions;
  buildRequest(message: OutgoingMessage, ctx: HttpRequestContext): HttpRequest;
  verifyRequest(ctx: HttpRequestContext): HttpRequest;
  /** The text of a refusal before the build, or null. */
  refuse?(message: OutgoingMessage): string | null;
  idFrom?: HttpIdFrom | undefined;
  classify?: HttpClassifyHook | undefined;
}

/**
 * The ids of the built-in providers, and `http` itself. A generic adapter cannot use one,
 * so scopes, caps, and stored credentials never mix with a built-in provider. A test
 * keeps this list equal to the catalog.
 */
export const RESERVED_PROVIDER_IDS: readonly string[] = Object.freeze([
  "resend",
  "tosend",
  "cloudflare-rest",
  "cloudflare-binding",
  "mailgun",
  "postmark",
  "brevo",
  "mailersend",
  "mailjet",
  "smtp2go",
  "zeptomail",
  "sendgrid",
  "ses",
  "smtp",
  "mailchannels",
  "ahasend",
  "mailtrap",
  "autosend",
  "scaleway",
  "http",
]);

const ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Checks the id of a generic adapter: a lowercase letter, then 1 to 31 lowercase letters,
 * digits, or hyphens. It must not be a built-in provider id.
 *
 * @throws TypeError for any other value. The error never holds the value.
 */
export function checkProviderId(id: unknown, label: string): string {
  if (typeof id !== "string" || !ID.test(id)) {
    throw new TypeError(
      `${label} must be a lowercase letter, then 1 to 31 lowercase letters, digits, or hyphens.`,
    );
  }
  if (RESERVED_PROVIDER_IDS.includes(id)) {
    throw new TypeError(`${label} is the id of a built-in provider. Choose another id.`);
  }
  return id;
}

/** Checks a display name: a string of 1 to 100 characters with no control character. */
export function checkProviderName(name: unknown, label: string): string {
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.length > 100 ||
    hasForbiddenChars(name)
  ) {
    throw new TypeError(`${label} must be a name of 1 to 100 characters.`);
  }
  return name.trim();
}

const PATH = /^[A-Za-z0-9_$-]{1,64}(\.[A-Za-z0-9_$-]{1,64}){0,15}$/;
const MAX_ID_LENGTH = 256;

/** True for a dot path that `idFrom` accepts, for example `data.messageId` or `ids.0`. */
export function isIdPath(path: unknown): path is string {
  return typeof path === "string" && PATH.test(path);
}

/** Reads a dot path from a parsed JSON value. Only own fields and array indexes count. */
function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (Array.isArray(current)) {
      current = /^\d+$/.test(key) ? current[Number(key)] : undefined;
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/** A message id that is safe to return, or undefined. */
function cleanId(value: unknown): string | undefined {
  const text =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (text === "" || text.length > MAX_ID_LENGTH || hasForbiddenChars(text)) return undefined;
  return text;
}

function readId(
  idFrom: HttpIdFrom | undefined,
  body: unknown,
  headers: Headers,
): string | undefined {
  if (idFrom === undefined) return undefined;
  if (typeof idFrom === "string") return cleanId(readPath(body, idFrom));
  try {
    return cleanId(idFrom(body, headers));
  } catch {
    // The provider accepted the message. A reader that throws gives no id.
    return undefined;
  }
}

type Prepared = { ok: true; init: PreparedRequest } | { ok: false; result: NotSentResult };

interface PreparedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: string | Uint8Array<ArrayBuffer>;
}

/** Creates one adapter from a checked spec. */
export function createHttpAdapter(spec: HttpEngineSpec): ProviderAdapter {
  const { meta, rules } = spec;
  const provider = meta.id;

  function refusal(reason: FailureReason, message: string): Prepared {
    return { ok: false, result: { status: "not_sent", reason, message, provider } };
  }

  function prepare(build: () => HttpRequest, operation: "send" | "verify"): Prepared {
    let request: HttpRequest;
    try {
      request = build();
    } catch {
      // Nothing was sent. The error text can hold a credential, so it is dropped.
      return refusal(
        "invalid_message",
        `The ${operation} request builder threw. No request was sent.`,
      );
    }
    if (typeof request !== "object" || request === null) {
      return refusal("invalid_message", `The ${operation} request builder returned no request.`);
    }
    const method = request.method ?? (operation === "send" ? "POST" : "GET");
    if (typeof method !== "string" || !HTTP_METHODS.includes(method)) {
      return refusal(
        "invalid_message",
        `The ${operation} request has a method that is not allowed.`,
      );
    }
    const checked = checkRequestUrl(request.url, spec.urlRules);
    if (!checked.ok) {
      return refusal(
        "unsupported",
        `${describeBreak(`The ${operation} URL`, checked.rule)} No request was sent.`,
      );
    }
    let headers: Headers;
    try {
      headers = new Headers(request.headers ?? {});
    } catch {
      return refusal("invalid_message", `The ${operation} request has a header that is not valid.`);
    }
    const init: PreparedRequest = { url: checked.url.href, method, headers };
    const body = request.body;
    if (body === undefined || body === null) return { ok: true, init };
    if (method === "GET" || method === "HEAD") {
      return refusal("invalid_message", `The ${operation} request has a body with ${method}.`);
    }
    if (typeof body === "string" || body instanceof Uint8Array) {
      init.body = body;
      return { ok: true, init };
    }
    if (typeof body !== "object") {
      return refusal("invalid_message", `The ${operation} request has a body that is not valid.`);
    }
    try {
      init.body = JSON.stringify(body);
    } catch {
      return refusal("invalid_message", `The ${operation} request has a body that is not valid.`);
    }
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return { ok: true, init };
  }

  async function call(
    prepared: PreparedRequest,
    ctx: SendContext,
    operation: "send" | "verify",
  ): Promise<SendResult> {
    const result = await callProvider({
      url: prepared.url,
      method: prepared.method,
      headers: prepared.headers,
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
      // Never follow a redirect. A 3xx is unknown.
      redirect: "manual",
    });
    if (!result.ok) return { ...transportOutcome(result.result.reason), provider };
    const { response } = result;
    const success = response.status >= 200 && response.status <= 299;
    const hook = spec.classify;
    const wantsBody =
      hook !== undefined || (success && operation === "send" && spec.idFrom !== undefined);
    let body: unknown = null;
    if (wantsBody) body = await readJson(response);
    else await discardBody(response);
    let answer: unknown;
    if (hook !== undefined) {
      try {
        // A hook that answers undefined keeps the table result.
        answer = hook({
          operation,
          status: response.status,
          headers: new Headers(response.headers),
          body,
        });
      } catch {
        // A hook that throws gives no safe answer. The request may have reached the provider.
        answer = null;
      }
    }
    const outcome = classifyHttp(response.status, response.headers, rules, ctx.now, answer);
    if (outcome.status !== "sent") return { ...outcome, provider };
    if (operation === "verify") return { status: "sent", provider };
    return sentResult(provider, readId(spec.idFrom, body, response.headers));
  }

  function requestContext(ctx: SendContext): HttpRequestContext {
    return { credentials: ctx.credentials, now: ctx.now };
  }

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, meta.capabilities);
    if (!checked.ok) return { ...checked.result, provider };
    const refused = spec.refuse?.(message) ?? null;
    if (refused !== null) {
      return { status: "not_sent", reason: "unsupported", message: refused, provider };
    }
    const prepared = prepare(() => spec.buildRequest(message, requestContext(ctx)), "send");
    if (!prepared.ok) return prepared.result;
    return call(prepared.init, ctx, "send");
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const prepared = prepare(() => spec.verifyRequest(requestContext(ctx)), "verify");
    if (!prepared.ok) return { ...prepared.result, ok: false };
    const result = await call(prepared.init, ctx, "verify");
    if (result.status === "sent") return { ok: true };
    return { ...result, ok: false };
  }

  return defineProvider({ meta, send, verify });
}
