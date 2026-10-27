// The verify call and the failure classifier that several HTTP adapters share. They live
// in their own module so that an adapter which does not use them does not carry them.

import type { VerifyResult } from "../core/adapter";
import type { StatusMap } from "../core/classify";
import type { NotSentResult, UnknownResult } from "../core/types";
import {
  callProvider,
  classifyFailure,
  discardBody,
  type ProviderRequest,
  readJson,
  withProvider,
} from "./http";

/** A classifier of a non-2xx response. */
export type FailureClassifier = (response: Response) => Promise<NotSentResult | UnknownResult>;

/**
 * Classifies a non-2xx response with the status map, and refines a `not_sent` result from
 * the JSON body. An `unknown` result does not read the body.
 */
export async function classifyWithBody(
  response: Response,
  statusMap: StatusMap | undefined,
  now: number,
  provider: string,
  refine: (result: NotSentResult, json: unknown) => NotSentResult,
): Promise<NotSentResult | UnknownResult> {
  const outcome = classifyFailure(response, statusMap, now, provider);
  if (outcome.status === "unknown") {
    await discardBody(response);
    return outcome;
  }
  return refine(outcome, await readJson(response));
}

/**
 * Sends one authenticated `GET` for `verify`. A 2xx is `{ ok: true }`. A transport
 * failure keeps its `unknown` result. Any other status goes to `failure`, or to the
 * status map when `failure` is not set.
 */
export async function verifyByGet(
  request: Omit<ProviderRequest, "method" | "body">,
  provider: string,
  statusMap: StatusMap | undefined,
  now: number,
  failure?: FailureClassifier,
): Promise<VerifyResult> {
  const call = await callProvider({ ...request, method: "GET" });
  if (!call.ok) return { ...withProvider(call.result, provider), ok: false };
  const { response } = call;
  if (response.ok) {
    await discardBody(response);
    return { ok: true };
  }
  if (failure !== undefined) return { ...(await failure(response)), ok: false };
  await discardBody(response);
  return { ...classifyFailure(response, statusMap, now, provider), ok: false };
}
