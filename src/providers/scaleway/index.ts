// mailswitch/scaleway: the Scaleway Transactional Email adapter. It sends one message
// with `POST /transactional-email/v1alpha1/regions/fr-par/emails` and checks the key with
// `GET .../domains`. The IAM secret key goes in the `X-Auth-Token` header. The Project ID
// goes in the body of a send and in the query of verify. fr-par is the only region of
// the service. Scaleway has no idempotency key, so the mailer store gives the only
// duplicate protection. The API is v1alpha1. Checked 2026-10-27.
// https://www.scaleway.com/en/developers/api/transactional-email/v1alpha1/schema.yml
// https://www.scaleway.com/en/docs/transactional-email/reference-content/tem-capabilities-and-limits/
// https://www.scaleway.com/en/developers/api/
//
// - A 2xx with a non-empty `emails[]` whose first entry has an `id` is `sent`, with that
//   id. When every entry has the status `failed` or `canceled`, the result is `unknown`.
//   Any other 2xx body is `unknown`.
// - A 4xx reason is refined from the error `type` in the body. The type names come from
//   the error types of the official Scaleway SDKs.
// - Every 5xx is `unknown`.

import {
  defineProvider,
  type ProviderAdapter,
  type SendContext,
  type VerifyResult,
} from "../../core/adapter";
import { validateMessage } from "../../core/message";
import type {
  FailureReason,
  NotSentResult,
  OutgoingMessage,
  SendResult,
  UnknownResult,
} from "../../core/types";
import { credentialOrOption } from "../../internal/credential";
import {
  callProvider,
  classifyFailure,
  discardBody,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../internal/http";
import { asRecord } from "../../internal/json";
import { scalewayMeta } from "./meta";
import { scalewayPayload, scalewayRefusal } from "./payload";

export { scalewayMeta } from "./meta";

/** The Scaleway API origin. */
export const SCALEWAY_API_BASE = "https://api.scaleway.com";

/** The path of the Transactional Email API in fr-par, the only region of the service. */
export const SCALEWAY_TEM_PATH = "/transactional-email/v1alpha1/regions/fr-par";

/** Options of `scaleway`. Each credential field takes precedence over its option. */
export interface ScalewayOptions {
  /** The secret key of an IAM API key. */
  secretKey?: string;
  /** The ID of the Project that holds the verified domain. */
  projectId?: string;
  /** The API origin. Defaults to `SCALEWAY_API_BASE`. Tests and proxies change it. */
  baseUrl?: string;
}

const PROVIDER = scalewayMeta.id;
const TYPE = /^[a-z][a-z_]{0,63}$/;

// The 4xx reason of each Scaleway error type. Any other type keeps the status reason.
// https://www.scaleway.com/en/developers/api/
const REASONS: Readonly<Record<string, FailureReason>> = {
  invalid_arguments: "invalid_message",
  quotas_exceeded: "quota",
  permissions_denied: "auth",
  denied_authentication: "auth",
};

/**
 * Refines a `not_sent` result from the body `type`. It changes only the reason and the
 * message. The message never copies the body.
 */
function refine(result: NotSentResult, json: unknown): NotSentResult {
  const raw = asRecord(json)?.type;
  if (typeof raw !== "string" || !TYPE.test(raw)) return result;
  const reason = Object.hasOwn(REASONS, raw) ? (REASONS[raw] as FailureReason) : result.reason;
  return {
    ...result,
    reason,
    message: `Scaleway answered with HTTP ${result.httpStatus} ${raw} (${reason}).`,
  };
}

/** Classifies a failed response. Only a `not_sent` body is read. */
async function failure(response: Response, now: number): Promise<NotSentResult | UnknownResult> {
  const outcome = classifyFailure(response, scalewayMeta.statusMap, now, PROVIDER);
  if (outcome.status === "unknown") {
    await discardBody(response);
    return outcome;
  }
  return refine(outcome, await readJson(response));
}

function unclear(httpStatus: number, message: string): UnknownResult {
  return { status: "unknown", reason: "provider_error", message, httpStatus, provider: PROVIDER };
}

/** Reads a 2xx send answer. */
function accepted(json: unknown, httpStatus: number): SendResult {
  const raw = asRecord(json)?.emails;
  const emails = Array.isArray(raw) ? raw.map(asRecord) : [];
  const id = emails[0]?.id;
  if (typeof id !== "string" || id.trim() === "") {
    return unclear(
      httpStatus,
      "Scaleway accepted the request with an answer that mailswitch cannot read.",
    );
  }
  if (emails.every((item) => item?.status === "failed" || item?.status === "canceled")) {
    return unclear(httpStatus, "Scaleway marked every recipient of this email failed or canceled.");
  }
  return { status: "sent", provider: PROVIDER, providerMessageId: id.trim() };
}

function checkOptions(options: ScalewayOptions): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("scaleway expects an options object.");
  }
  for (const name of ["secretKey", "projectId"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "string") {
      throw new TypeError(`scaleway: ${name} must be a string.`);
    }
  }
  return parseBaseUrl(options.baseUrl, SCALEWAY_API_BASE, "scaleway: baseUrl");
}

/**
 * Creates the Scaleway Transactional Email adapter.
 *
 * @throws TypeError for invalid options.
 */
export function scaleway(options: ScalewayOptions = {}): ProviderAdapter {
  const base = `${checkOptions(options)}${SCALEWAY_TEM_PATH}`;

  function headers(ctx: SendContext): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "x-auth-token": (ctx.credentials.secretKey || options.secretKey || "").trim(),
    };
  }

  function project(ctx: SendContext): string {
    return credentialOrOption(
      ctx.credentials,
      ctx.defaultedFields,
      "projectId",
      options.projectId,
    ).trim();
  }

  const noProject = (): NotSentResult => ({
    status: "not_sent",
    reason: "auth",
    message: "Scaleway needs a Project ID.",
    provider: PROVIDER,
  });

  async function send(message: OutgoingMessage, ctx: SendContext): Promise<SendResult> {
    const checked = validateMessage(message, scalewayMeta.capabilities);
    if (!checked.ok) return withProvider(checked.result, PROVIDER);
    const refusal = scalewayRefusal(message);
    if (refusal !== null) {
      return { status: "not_sent", reason: "unsupported", message: refusal, provider: PROVIDER };
    }
    const projectId = project(ctx);
    if (projectId === "") return noProject();
    const call = await callProvider({
      url: `${base}/emails`,
      headers: headers(ctx),
      body: JSON.stringify(scalewayPayload(message, projectId)),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return withProvider(call.result, PROVIDER);
    const { response } = call;
    if (!response.ok) return failure(response, ctx.now);
    return accepted(await readJson(response), response.status);
  }

  async function verify(ctx: SendContext): Promise<VerifyResult> {
    const projectId = project(ctx);
    if (projectId === "") return { ...noProject(), ok: false };
    // The domain list is an authenticated read. It sends no email. An empty list is ok.
    const query = `project_id=${encodeURIComponent(projectId)}&page_size=1`;
    const call = await callProvider({
      url: `${base}/domains?${query}`,
      method: "GET",
      headers: headers(ctx),
      timeoutMs: ctx.timeoutMs,
      fetch: ctx.fetch,
    });
    if (!call.ok) return { ...withProvider(call.result, PROVIDER), ok: false };
    if (call.response.ok) {
      await discardBody(call.response);
      return { ok: true };
    }
    return { ...(await failure(call.response, ctx.now)), ok: false };
  }

  return defineProvider({ meta: scalewayMeta, send, verify });
}
