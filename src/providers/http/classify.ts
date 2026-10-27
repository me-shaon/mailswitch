// The status rules of the generic HTTP provider. Both APIs call `classifyHttp`. Its
// endpoint has no researched docs, so it has its own base table, and code enforces the
// cardinal rule: no configuration can turn a 5xx, a 3xx, a 408, a 409, a timeout, or a
// transport error into `not_sent`.
//
// Base table:
//   2xx                       sent
//   400, 413, 415, 422        not_sent / invalid_message
//   401, 403                  not_sent / auth
//   402                       not_sent / credits
//   429                       not_sent / rate_limited (retryAfterMs from Retry-After)
//   every other status        unknown / provider_error
//
// `unknownStatuses` moves any 4xx code to unknown. `notSentStatuses` opts more 4xx codes
// into not_sent / rejected, except 408 and 409. A hook answer of `not_sent` for any other
// code becomes unknown, and so does a hook answer of `sent` for a code that is not 2xx.

import { parseRetryAfter } from "../../core/classify";
import type { FailureReason, NotSentResult, SentResult, UnknownResult } from "../../core/types";

/** The base `not_sent` codes of the generic provider, with their reasons. */
export const HTTP_BASE_NOT_SENT: Readonly<Record<number, FailureReason>> = Object.freeze({
  400: "invalid_message",
  401: "auth",
  402: "credits",
  403: "auth",
  413: "invalid_message",
  415: "invalid_message",
  422: "invalid_message",
  429: "rate_limited",
});

/** The 4xx codes that can never be `not_sent`: the request may still be in progress. */
export const HTTP_NEVER_NOT_SENT: readonly number[] = Object.freeze([408, 409]);

/** The reasons that a `classify` hook can give with `not_sent`. */
export const HTTP_HOOK_REASONS: readonly FailureReason[] = Object.freeze([
  "auth",
  "rate_limited",
  "quota",
  "credits",
  "rejected",
  "invalid_message",
]);

/** The checked status lists of one adapter. */
export interface HttpStatusRules {
  notSent: ReadonlySet<number>;
  unknown: ReadonlySet<number>;
}

function statusList(value: unknown, label: string, notSent: boolean): Set<number> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of status codes.`);
  const out = new Set<number>();
  value.forEach((code: unknown, index) => {
    const where = `${label}[${index}]`;
    if (typeof code !== "number" || !Number.isInteger(code) || code < 400 || code > 499) {
      throw new TypeError(`${where} must be an integer from 400 to 499.`);
    }
    if (notSent && HTTP_NEVER_NOT_SENT.includes(code)) {
      throw new TypeError(`${where} must not be 408 or 409. Those codes stay unknown.`);
    }
    out.add(code);
  });
  return out;
}

/**
 * Checks `notSentStatuses` and `unknownStatuses`.
 *
 * @param prefix The option prefix in the error, for example `"httpProvider: "`.
 * @throws TypeError for a code outside 400 to 499, a `notSentStatuses` entry of 408 or
 * 409, or a code in both lists.
 */
export function parseStatusRules(
  notSentStatuses: unknown,
  unknownStatuses: unknown,
  prefix: string,
): HttpStatusRules {
  const notSent = statusList(notSentStatuses, `${prefix}notSentStatuses`, true);
  const unknown = statusList(unknownStatuses, `${prefix}unknownStatuses`, false);
  for (const code of notSent) {
    if (unknown.has(code)) {
      throw new TypeError(`${prefix}a status code is in notSentStatuses and unknownStatuses.`);
    }
  }
  return { notSent, unknown };
}

/** True when the rules allow `not_sent` for this status. This is the guard of the rule. */
export function mayBeNotSent(status: number, rules: HttpStatusRules): boolean {
  return (
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 499 &&
    !HTTP_NEVER_NOT_SENT.includes(status) &&
    !rules.unknown.has(status)
  );
}

/** What a `classify` hook can answer. Return undefined to keep the table result. */
export type HttpClassifyAnswer =
  | { status: "sent" }
  | { status: "not_sent"; reason: FailureReason }
  | { status: "unknown" };

/** The classification of one response, before the provider id and the message id. */
export type HttpOutcome =
  | { status: "sent" }
  | Omit<NotSentResult, "provider">
  | Omit<UnknownResult, "provider">;

function unknownOutcome(status: number): Omit<UnknownResult, "provider"> {
  return {
    status: "unknown",
    reason: "provider_error",
    message: `The provider answered with HTTP ${status} (provider_error).`,
    httpStatus: status,
  };
}

function notSentOutcome(
  status: number,
  reason: FailureReason,
  headers: Headers | null,
  now: number,
): Omit<NotSentResult, "provider"> {
  const base: Omit<NotSentResult, "provider"> = {
    status: "not_sent",
    reason,
    message: `The provider answered with HTTP ${status} (${reason}).`,
    httpStatus: status,
  };
  if (reason !== "rate_limited") return base;
  const retryAfterMs = parseRetryAfter(headers?.get("retry-after"), now);
  return retryAfterMs === undefined ? base : { ...base, retryAfterMs };
}

/** The result of the table alone. */
function tableOutcome(
  status: number,
  headers: Headers | null,
  rules: HttpStatusRules,
  now: number,
): HttpOutcome {
  if (Number.isInteger(status) && status >= 200 && status <= 299) return { status: "sent" };
  if (rules.unknown.has(status)) return unknownOutcome(status);
  const base = Object.hasOwn(HTTP_BASE_NOT_SENT, status) ? HTTP_BASE_NOT_SENT[status] : undefined;
  if (base !== undefined) return notSentOutcome(status, base, headers, now);
  if (rules.notSent.has(status)) return notSentOutcome(status, "rejected", headers, now);
  return unknownOutcome(status);
}

/**
 * Classifies one response. The hook answer, when it is given, replaces the table result
 * within the same rules. The guard runs last: a `not_sent` result for a status that the
 * rules do not allow becomes unknown, and so does a `sent` result for a status that is
 * not 2xx. A hook answer of an unknown shape is unknown.
 */
export function classifyHttp(
  status: number,
  headers: Headers | null,
  rules: HttpStatusRules,
  now: number,
  answer?: unknown,
): HttpOutcome {
  let outcome = tableOutcome(status, headers, rules, now);
  if (answer !== undefined) outcome = hookOutcome(status, headers, now, answer);
  if (outcome.status === "not_sent" && !mayBeNotSent(status, rules)) {
    return unknownOutcome(status);
  }
  if (outcome.status === "sent" && !(Number.isInteger(status) && status >= 200 && status <= 299)) {
    return unknownOutcome(status);
  }
  return outcome;
}

function hookOutcome(
  status: number,
  headers: Headers | null,
  now: number,
  answer: unknown,
): HttpOutcome {
  if (typeof answer !== "object" || answer === null) return unknownOutcome(status);
  const record = answer as { status?: unknown; reason?: unknown };
  if (record.status === "sent") return { status: "sent" };
  if (record.status === "not_sent") {
    const reason = record.reason;
    if (typeof reason === "string" && HTTP_HOOK_REASONS.includes(reason as FailureReason)) {
      return notSentOutcome(status, reason as FailureReason, headers, now);
    }
  }
  return unknownOutcome(status);
}

/** The `unknown` result of a timeout or a thrown fetch. Its message holds no URL. */
export function transportOutcome(reason: FailureReason): Omit<UnknownResult, "provider"> {
  return reason === "timeout"
    ? { status: "unknown", reason: "timeout", message: "The provider did not answer in time." }
    : {
        status: "unknown",
        reason: "network",
        message: "The request to the provider failed at the network level.",
      };
}

/** A sent result with the id, when there is one. The adapter never invents an id. */
export function sentResult(provider: string, id: string | undefined): SentResult {
  return id === undefined
    ? { status: "sent", provider }
    : { status: "sent", provider, providerMessageId: id };
}
