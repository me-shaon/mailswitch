// mailswitch/http: the generic HTTP provider. It sends to a simple JSON API that
// mailswitch does not ship, with no adapter code (`httpProviderFromConfig`) or with a
// small amount of code (`httpProvider`). Both APIs give the same adapter, at tier 2.
//
// The safety rules are in code, not only in the docs:
// - No option can map a 5xx, a 3xx, a 408, a 409, a timeout, or a transport error to
//   `not_sent`. See classify.ts.
// - Every request goes to an `https` host that passes the host rules, and never follows
//   a redirect. See hosts.ts.
// - The JSON config API requires an `allowHosts` list from the deployer.

import type { ProviderAdapter } from "../../core/adapter";
import type { CredentialField } from "../../core/meta";
import type { Capabilities, OutgoingMessage } from "../../core/types";
import {
  checkProviderId,
  checkProviderName,
  createHttpAdapter,
  type HttpClassifyHook,
  type HttpIdFrom,
  type HttpRequest,
  type HttpRequestContext,
  isIdPath,
} from "./adapter";
import { parseStatusRules } from "./classify";
import { parseAllowHosts } from "./hosts";
import { genericMeta, HTTP_DOCS_URL } from "./meta";

export {
  HTTP_METHODS,
  type HttpClassifyHook,
  type HttpClassifyInput,
  type HttpIdFrom,
  type HttpRequest,
  type HttpRequestBody,
  type HttpRequestContext,
  RESERVED_PROVIDER_IDS,
} from "./adapter";
export {
  HTTP_BASE_NOT_SENT,
  HTTP_HOOK_REASONS,
  HTTP_NEVER_NOT_SENT,
  type HttpClassifyAnswer,
} from "./classify";
export {
  HTTP_AUTH_HEADERS,
  type HttpAttachmentFieldMap,
  type HttpAuthConfig,
  type HttpConfigOptions,
  type HttpFieldMap,
  type HttpProviderConfig,
  httpProviderFromConfig,
} from "./config";
export { HTTP_DOCS_URL, httpMeta } from "./meta";

/**
 * What a code-API adapter can send. Tier 2 needs attachments. The adapter has no native
 * idempotency and no batch endpoint, so those fields are not options.
 */
export type HttpCapabilities = Omit<
  Capabilities,
  "attachments" | "idempotency" | "batchSize" | "batchAttachments"
> & {
  attachments: true;
};

/** Options of `httpProvider`. */
export interface HttpProviderOptions {
  /** The provider id. It must not be the id of a built-in provider. Scopes and caps use it. */
  id: string;
  /** The display name. */
  name: string;
  /** The fields of the credential form. At least one is a required secret. */
  credentialFields: readonly CredentialField[];
  /** What the API can send. */
  capabilities: HttpCapabilities;
  /** Builds the send request of one message. The host rules apply to its URL. */
  buildRequest(message: OutgoingMessage, ctx: HttpRequestContext): HttpRequest;
  /** Builds a request that checks the credentials and sends no email. */
  verifyRequest(ctx: HttpRequestContext): HttpRequest;
  /** Reads the message id of a 2xx answer. A dot path into the JSON body, or a function. */
  idFrom?: HttpIdFrom;
  /** Changes the table result within the same rules. See `HttpClassifyAnswer`. */
  classify?: HttpClassifyHook;
  /** More 4xx codes that mean "not sent". Never 408 or 409. */
  notSentStatuses?: readonly number[];
  /** 4xx codes that mean "may have sent", for example a duplicate or a conflict. */
  unknownStatuses?: readonly number[];
  /** The hosts that a request may reach, as `host` or `host:port`. Recommended. */
  allowHosts?: readonly string[];
  /** The docs of the API. Defaults to the guide of the generic provider. */
  docsUrl?: string;
}

const LABEL = "httpProvider";

function checkCapabilities(value: unknown): Capabilities {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${LABEL}: capabilities must be an object.`);
  }
  const caps = value as Partial<Capabilities>;
  if (caps.attachments !== true) {
    throw new TypeError(
      `${LABEL}: capabilities.attachments must be true. Tier 2 needs attachments.`,
    );
  }
  for (const flag of ["cc", "bcc", "replyTo", "customHeaders"] as const) {
    if (typeof caps[flag] !== "boolean") {
      throw new TypeError(`${LABEL}: capabilities.${flag} must be a boolean.`);
    }
  }
  const max = caps.maxMessageBytes;
  if (max !== null && !(Number.isInteger(max) && (max as number) > 0)) {
    throw new TypeError(
      `${LABEL}: capabilities.maxMessageBytes must be null or a positive integer.`,
    );
  }
  const recipients = caps.maxRecipients;
  if (recipients !== undefined && !(Number.isInteger(recipients) && recipients > 0)) {
    throw new TypeError(`${LABEL}: capabilities.maxRecipients must be a positive integer.`);
  }
  return {
    attachments: true,
    maxMessageBytes: max as number | null,
    cc: caps.cc as boolean,
    bcc: caps.bcc as boolean,
    replyTo: caps.replyTo as boolean,
    customHeaders: caps.customHeaders as boolean,
    idempotency: false,
    batchSize: 1,
    ...(recipients === undefined ? {} : { maxRecipients: recipients }),
  };
}

function checkFields(value: unknown): readonly CredentialField[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${LABEL}: credentialFields must list at least one field.`);
  }
  const fields = value as CredentialField[];
  if (!fields.some((field) => field?.secret === true && field.required === true)) {
    throw new TypeError(`${LABEL}: credentialFields must have a required secret field.`);
  }
  return fields.map((field) => ({ ...field }));
}

/**
 * Creates a generic HTTP adapter from code. The adapter is tier 2. Its host rules apply to
 * each URL that `buildRequest` and `verifyRequest` return. A URL that breaks a rule is
 * `not_sent/unsupported`, with no fetch.
 *
 * @throws TypeError for invalid options. The error names the option, never its value.
 */
export function httpProvider(options: HttpProviderOptions): ProviderAdapter {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`${LABEL} expects an options object.`);
  }
  const id = checkProviderId(options.id, `${LABEL}: id`);
  const name = checkProviderName(options.name, `${LABEL}: name`);
  const capabilities = checkCapabilities(options.capabilities);
  const credentialFields = checkFields(options.credentialFields);
  if (typeof options.buildRequest !== "function") {
    throw new TypeError(`${LABEL}: buildRequest must be a function.`);
  }
  if (typeof options.verifyRequest !== "function") {
    throw new TypeError(`${LABEL}: verifyRequest must be a function.`);
  }
  const idFrom = options.idFrom;
  if (idFrom !== undefined && typeof idFrom !== "function" && !isIdPath(idFrom)) {
    throw new TypeError(`${LABEL}: idFrom must be a dot path or a function.`);
  }
  if (options.classify !== undefined && typeof options.classify !== "function") {
    throw new TypeError(`${LABEL}: classify must be a function.`);
  }
  const rules = parseStatusRules(options.notSentStatuses, options.unknownStatuses, `${LABEL}: `);
  const allowHosts =
    options.allowHosts === undefined
      ? undefined
      : parseAllowHosts(options.allowHosts, `${LABEL}: allowHosts`);
  const docsUrl = options.docsUrl ?? HTTP_DOCS_URL;
  if (typeof docsUrl !== "string" || !docsUrl.startsWith("https://")) {
    throw new TypeError(`${LABEL}: docsUrl must be an https URL.`);
  }
  return createHttpAdapter({
    meta: genericMeta(id, name, capabilities, credentialFields, docsUrl),
    rules,
    urlRules: { allowHosts },
    buildRequest: options.buildRequest,
    verifyRequest: options.verifyRequest,
    idFrom,
    classify: options.classify,
  });
}
