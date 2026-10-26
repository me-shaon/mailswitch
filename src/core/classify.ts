// The status classifier. It turns an HTTP status, or an error that fetch threw, into a
// delivery status and a reason. The default table is data. A provider overrides single
// codes with a status map, and each override cites the documentation that proves it.
//
// Default table:
//   2xx                     sent
//   400, 413, 415, 422      not_sent / invalid_message
//   401, 403                not_sent / auth
//   402                     not_sent / credits
//   429                     not_sent / rate_limited (retryAfterMs from Retry-After)
//   other 4xx               not_sent / rejected
//   5xx                     unknown / provider_error
//   anything else           unknown / provider_error (when in doubt, unknown)
//   timeout                 unknown / timeout
//   other thrown error      unknown / network

import type { FailureReason, NotSentResult, UnknownResult } from "./types";

/** One sourced override for an HTTP status code. */
export interface StatusOverride {
  status: "not_sent" | "unknown";
  reason: FailureReason;
  /** An http or https URL of the provider documentation that proves this mapping. */
  source: string;
}

/** Per-code overrides of the default table, keyed by an HTTP status from 400 to 599. */
export type StatusMap = Readonly<Record<number, StatusOverride>>;

/** The classification of a 2xx response. */
export interface SentMarker {
  status: "sent";
}

/** What `classifyResponse` returns. */
export type ResponseClassification = SentMarker | NotSentResult | UnknownResult;

const INVALID_MESSAGE_CODES: ReadonlySet<number> = new Set([400, 413, 415, 422]);

function checkOverride(code: number, override: StatusOverride | undefined): StatusOverride {
  if (!Number.isInteger(code) || code < 400 || code > 599) {
    throw new RangeError(`A status map key must be an HTTP status from 400 to 599, got ${code}.`);
  }
  if (!override || (override.status !== "not_sent" && override.status !== "unknown")) {
    throw new TypeError(`The status map entry for ${code} needs a status of not_sent or unknown.`);
  }
  if (typeof override.reason !== "string" || (override.reason as string) === "") {
    throw new TypeError(`The status map entry for ${code} needs a reason.`);
  }
  let url: URL | undefined;
  try {
    url = typeof override.source === "string" ? new URL(override.source) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new TypeError(
      `The status map entry for ${code} needs a source: the URL of the documentation that proves it.`,
    );
  }
  return override;
}

/**
 * Checks and freezes a status map. It throws when a key is not a 4xx or 5xx code, or when
 * an entry has no valid status, reason, or source URL.
 */
export function defineStatusMap(map: Record<number, StatusOverride>): StatusMap {
  const out: Record<number, StatusOverride> = {};
  for (const key of Object.keys(map)) {
    const code = Number(key);
    const entry = checkOverride(code, map[code]);
    out[code] = Object.freeze({ status: entry.status, reason: entry.reason, source: entry.source });
  }
  return Object.freeze(out);
}

/**
 * Parses a `Retry-After` value, in delta seconds or as an HTTP date, into milliseconds.
 * Returns undefined for a missing or invalid value. A date in the past gives 0.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // An HTTP date always names a day or a month. This stops Date.parse from reading "-1" as a year.
  if (!/[a-z]/i.test(text)) return undefined;
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function defaultFor(status: number): Pick<StatusOverride, "status" | "reason"> {
  if (status >= 400 && status <= 499) {
    if (status === 401 || status === 403) return { status: "not_sent", reason: "auth" };
    if (status === 402) return { status: "not_sent", reason: "credits" };
    if (status === 429) return { status: "not_sent", reason: "rate_limited" };
    if (INVALID_MESSAGE_CODES.has(status)) return { status: "not_sent", reason: "invalid_message" };
    return { status: "not_sent", reason: "rejected" };
  }
  return { status: "unknown", reason: "provider_error" };
}

/** Options for `classifyResponse`. */
export interface ClassifyResponseOptions {
  /** The current time in Unix milliseconds, for a `Retry-After` HTTP date. */
  now?: number;
}

/**
 * Classifies an HTTP response by its status code. A 2xx gives `{ status: "sent" }`. Every
 * other code gives a failure result with a fixed, safe message. The message never holds
 * the response body. An entry in `statusMap` replaces the default for its code.
 */
export function classifyResponse(
  status: number,
  headers?: Headers | null,
  statusMap?: StatusMap,
  options: ClassifyResponseOptions = {},
): ResponseClassification {
  if (status >= 200 && status <= 299) return { status: "sent" };
  const mapped = statusMap?.[status];
  const rule = mapped ? checkOverride(status, mapped) : defaultFor(status);
  const message = `The provider answered with HTTP ${status} (${rule.reason}).`;
  const retryAfterMs = parseRetryAfter(headers?.get("retry-after"), options.now);
  const base = { reason: rule.reason, message, httpStatus: status };
  const fields = retryAfterMs === undefined ? base : { ...base, retryAfterMs };
  return rule.status === "not_sent"
    ? { status: "not_sent", ...fields }
    : { status: "unknown", ...fields };
}

/** Removes the query string, the fragment, and any credentials from a URL. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const cut = url.search(/[?#]/);
    const bare = cut === -1 ? url : url.slice(0, cut);
    return bare.replace(/\/\/[^/@]*@/, "//");
  }
}

/** Options for `classifyThrown`. */
export interface ClassifyThrownOptions {
  /** True when the request was aborted by its timeout. */
  timedOut?: boolean;
  /** The request URL. The message holds it without the query string or credentials. */
  url?: string;
}

/**
 * Classifies an error that fetch threw. The request may have reached the provider, so
 * the status is always `unknown`. The message never holds the error text.
 */
export function classifyThrown(error: unknown, options: ClassifyThrownOptions = {}): UnknownResult {
  const name = error instanceof Error ? error.name : "";
  const timedOut = options.timedOut === true || name === "TimeoutError";
  const target = options.url === undefined ? "" : ` (${redactUrl(options.url)})`;
  return timedOut
    ? {
        status: "unknown",
        reason: "timeout",
        message: `The provider did not answer in time${target}.`,
      }
    : {
        status: "unknown",
        reason: "network",
        message: `The request to the provider failed at the network level${target}.`,
      };
}
