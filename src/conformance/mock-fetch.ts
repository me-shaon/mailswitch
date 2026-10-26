// Fetch mocks for adapter tests and the conformance kit. `mockFetch` replays recorded
// provider exchanges. `echoFetch` reflects the whole request back, so the redaction
// check can prove that no secret from a request reaches a result. No test reaches a
// real provider.

import type { FetchLike } from "../internal/http";

/** A recorded HTTP response. */
export interface RecordedHttpResponse {
  status: number;
  headers?: Record<string, string>;
  /** A string is sent as is. Any other value is sent as JSON. */
  body?: unknown;
}

/** A recorded provider response. `timeout` and `network` simulate transport failures. */
export type RecordedResponse = RecordedHttpResponse | "timeout" | "network";

/** Which requests an exchange answers. */
export interface RequestMatcher {
  method: string;
  /** A full URL, or a pattern for URLs with ids. */
  url: string | RegExp;
}

/** One provider exchange: which request it answers, and the recorded response. */
export interface RecordedExchange extends RequestMatcher {
  /** What the exchange shows, for example "send with a wrong key". */
  label: string;
  response: RecordedResponse | ((request: CapturedRequest) => RecordedResponse);
  /** How many requests the exchange answers. Defaults to every matching request. */
  times?: number;
}

/** One request that a mock received. */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: Headers;
  /** The body as UTF-8 text. */
  body: string;
  /** The body as raw bytes. */
  bytes: Uint8Array;
}

/** A fetch mock and what it received. */
export interface FetchMock {
  fetch: FetchLike;
  /** Every request, in order. */
  calls: CapturedRequest[];
  /** The requests that no exchange matched. The mock threw a TypeError for each one. */
  unmatched: CapturedRequest[];
}

const decoder = new TextDecoder();

async function capture(input: string, init: RequestInit): Promise<CapturedRequest> {
  const request = new Request(input, init);
  const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
  return {
    method: request.method,
    url: request.url,
    headers: new Headers(request.headers),
    body: decoder.decode(bytes),
    bytes,
  };
}

function toResponse(recorded: RecordedHttpResponse): Response {
  const body =
    recorded.body === undefined
      ? null
      : typeof recorded.body === "string"
        ? recorded.body
        : JSON.stringify(recorded.body);
  const headers = new Headers(recorded.headers);
  if (body !== null && !headers.has("content-type") && typeof recorded.body !== "string") {
    headers.set("content-type", "application/json");
  }
  // A null body status (204, 205, 304) cannot carry a body.
  const empty = recorded.status === 204 || recorded.status === 205 || recorded.status === 304;
  return new Response(empty ? null : body, { status: recorded.status, headers });
}

/** True when a matcher fits a request. */
export function matches(matcher: RequestMatcher, request: CapturedRequest): boolean {
  if (matcher.method.toUpperCase() !== request.method) return false;
  return typeof matcher.url === "string"
    ? matcher.url === request.url
    : matcher.url.test(request.url);
}

function play(recorded: RecordedResponse): Response {
  if (recorded === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
  if (recorded === "network") throw new TypeError("Network connection lost.");
  return toResponse(recorded);
}

/** A fetch that answers each request with the first exchange that matches it. */
export function mockFetch(exchanges: readonly RecordedExchange[]): FetchMock {
  const remaining = exchanges.map((exchange) => ({ exchange, left: exchange.times ?? Infinity }));
  const calls: CapturedRequest[] = [];
  const unmatched: CapturedRequest[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const captured = await capture(input, init);
    calls.push(captured);
    const match = remaining.find((item) => item.left > 0 && matches(item.exchange, captured));
    if (!match) {
      unmatched.push(captured);
      throw new TypeError(`No recorded exchange for ${captured.method} ${captured.url}`);
    }
    match.left -= 1;
    const recorded =
      typeof match.exchange.response === "function"
        ? match.exchange.response(captured)
        : match.exchange.response;
    return play(recorded);
  };
  return { fetch: fetcher, calls, unmatched };
}

/** What an echo mock does with each request. */
export type EchoMode =
  /** Answer with this HTTP status and a body that reflects the request. */
  | number
  /** Throw a TimeoutError whose message holds the URL, the headers, and the body. */
  | "timeout"
  /** Throw a TypeError whose message holds the URL, the headers, and the body. */
  | "network";

function describeRequest(request: CapturedRequest): string {
  const headers = JSON.stringify(Object.fromEntries(request.headers.entries()));
  return `${request.method} ${request.url} headers=${headers} body=${request.body}`;
}

/**
 * A fetch that reflects every request. With a status, the response body is JSON with the
 * URL, the method, every header, and the body, and the response headers repeat the
 * request headers. With `timeout` or `network`, the thrown error message holds the same
 * data. A careless adapter that copies a response body or an error message leaks it.
 */
export function echoFetch(mode: EchoMode): FetchMock {
  const calls: CapturedRequest[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const captured = await capture(input, init);
    calls.push(captured);
    const text = describeRequest(captured);
    if (mode === "timeout") throw new DOMException(`Timed out: ${text}`, "TimeoutError");
    if (mode === "network") throw new TypeError(`fetch failed: ${text}`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [name, value] of captured.headers.entries()) headers[`x-echo-${name}`] = value;
    return toResponse({
      status: mode,
      headers,
      body: {
        message: `Echo: ${text}`,
        url: captured.url,
        method: captured.method,
        headers: Object.fromEntries(captured.headers.entries()),
        body: captured.body,
      },
    });
  };
  return { fetch: fetcher, calls, unmatched: [] };
}
