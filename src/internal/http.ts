// The fetch helper that every HTTP adapter shares. A timeout or a thrown fetch error is a
// result, not an exception, and it is always `unknown`: the request may have reached the
// provider before the error.

import { classifyThrown } from "../core/classify";
import type { SendResult, UnknownResult } from "../core/types";

/** The default request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** A fetch function. Inject one for tests or for a custom transport. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** One request to a provider API. */
export interface ProviderRequest {
  url: string;
  /** Defaults to `POST`. */
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  /** Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** The outcome of `callProvider`: a response with any status, or an `unknown` result. */
export type ProviderCall = { ok: true; response: Response } | { ok: false; result: UnknownResult };

/**
 * Sends one request with a timeout. Any status code gives `{ ok: true, response }`, so the
 * caller classifies it with `classifyResponse`. A timeout gives `unknown/timeout`, and any
 * other thrown error gives `unknown/network`.
 */
export async function callProvider(request: ProviderRequest): Promise<ProviderCall> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive number of milliseconds.");
  }
  const doFetch: FetchLike = request.fetch ?? ((input, init) => fetch(input, init));
  const signal = AbortSignal.timeout(timeoutMs);
  const init: RequestInit = { method: request.method ?? "POST", signal };
  if (request.headers !== undefined) init.headers = request.headers;
  if (request.body !== undefined) init.body = request.body;
  try {
    return { ok: true, response: await doFetch(request.url, init) };
  } catch (error) {
    return {
      ok: false,
      result: classifyThrown(error, { timedOut: signal.aborted, url: request.url }),
    };
  }
}

/** Reads a JSON body. Returns null for an empty body, an invalid body, or a read error. */
export async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Releases a response body that the caller does not read. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is already used or closed.
  }
}

/** Returns a copy of a result with the provider id set. */
export function withProvider<T extends SendResult>(result: T, provider: string): T {
  return { ...result, provider };
}

/**
 * Checks an API origin option and removes trailing slashes. Returns `fallback` when
 * `value` is undefined. The URL must be https, or http on a loopback host (`localhost`,
 * `127.x.x.x`, or `[::1]`) for tests. It must have no credentials, no query, and no
 * fragment.
 *
 * @param label The option name in the error, for example `"resend: baseUrl"`.
 * @throws TypeError for any other value.
 */
export function parseBaseUrl<D extends string | undefined>(
  value: unknown,
  fallback: D,
  label: string,
): string | D {
  if (value === undefined) return fallback;
  const url = typeof value === "string" && !/[?#@]/.test(value) ? URL.parse(value) : null;
  if (
    typeof value !== "string" ||
    !(
      url?.protocol === "https:" ||
      (url?.protocol === "http:" && /^(localhost|127\.[\d.]+|\[::1\])$/.test(url.hostname))
    )
  ) {
    throw new TypeError(`${label} must be an https URL.`);
  }
  return value.replace(/\/+$/, "");
}
