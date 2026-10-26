import { describe, expect, it } from "vitest";
import {
  classifyResponse,
  classifyThrown,
  defineStatusMap,
  parseRetryAfter,
  redactUrl,
  type StatusOverride,
} from "../../src/core/classify";

const RESEND_IDEMPOTENCY = "https://resend.com/docs/dashboard/emails/idempotency-keys";

describe("classifyResponse default table", () => {
  it("gives sent for 2xx", () => {
    for (const status of [200, 201, 202, 204]) {
      expect(classifyResponse(status, new Headers())).toEqual({ status: "sent" });
    }
  });

  it.each([
    [400, "invalid_message"],
    [401, "auth"],
    [402, "credits"],
    [403, "auth"],
    [404, "rejected"],
    [409, "rejected"],
    [413, "invalid_message"],
    [415, "invalid_message"],
    [422, "invalid_message"],
    [429, "rate_limited"],
    [451, "rejected"],
  ] as const)("gives not_sent for %i", (status, reason) => {
    const result = classifyResponse(status, new Headers());
    expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: status });
  });

  it.each([500, 502, 503, 504, 599])("gives unknown/provider_error for %i", (status) => {
    expect(classifyResponse(status, null)).toMatchObject({
      status: "unknown",
      reason: "provider_error",
      httpStatus: status,
    });
  });

  it("gives unknown for a status outside 2xx, 4xx, and 5xx", () => {
    expect(classifyResponse(302)).toMatchObject({ status: "unknown", reason: "provider_error" });
    expect(classifyResponse(0)).toMatchObject({ status: "unknown" });
  });

  it("puts the status and the reason in the message", () => {
    const result = classifyResponse(422);
    expect(result.status !== "sent" && result.message).toBe(
      "The provider answered with HTTP 422 (invalid_message).",
    );
  });
});

describe("Retry-After", () => {
  it("gives retryAfterMs 3000 for a 429 with Retry-After: 3", () => {
    const result = classifyResponse(429, new Headers({ "retry-after": "3" }));
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 3000,
    });
  });

  it("reads an HTTP date", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    const headers = new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:10 GMT" });
    expect(classifyResponse(429, headers, undefined, { now })).toMatchObject({
      retryAfterMs: 10_000,
    });
  });

  it("parses seconds, dates, and invalid values", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(" 120 ")).toBe(120_000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("-1")).toBeUndefined();
    expect(parseRetryAfter("1.5")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("omits retryAfterMs when the header is absent", () => {
    expect(classifyResponse(429, new Headers())).not.toHaveProperty("retryAfterMs");
  });
});

describe("status map overrides", () => {
  it("gives not_sent for a 503 with a sourced override", () => {
    const map = defineStatusMap({
      503: {
        status: "not_sent",
        reason: "provider_error",
        source: "https://example.com/docs/errors#503",
      },
    });
    expect(classifyResponse(503, null, map)).toMatchObject({
      status: "not_sent",
      reason: "provider_error",
      httpStatus: 503,
    });
    expect(classifyResponse(500, null, map)).toMatchObject({ status: "unknown" });
  });

  it("gives unknown for a 409 with a sourced override", () => {
    const map = defineStatusMap({
      409: { status: "unknown", reason: "in_flight", source: RESEND_IDEMPOTENCY },
    });
    expect(classifyResponse(409, null, map)).toMatchObject({
      status: "unknown",
      reason: "in_flight",
      httpStatus: 409,
    });
  });

  it("freezes the map", () => {
    const map = defineStatusMap({
      409: { status: "unknown", reason: "in_flight", source: RESEND_IDEMPOTENCY },
    });
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map[409])).toBe(true);
  });

  it("throws for an override without a source", () => {
    const entry = { status: "unknown", reason: "in_flight" } as unknown as StatusOverride;
    expect(() => defineStatusMap({ 409: entry })).toThrow(/source/);
    expect(() =>
      defineStatusMap({ 409: { status: "unknown", reason: "in_flight", source: "not a url" } }),
    ).toThrow(/source/);
    expect(() =>
      defineStatusMap({ 409: { status: "unknown", reason: "in_flight", source: "ftp://x.test" } }),
    ).toThrow(/source/);
  });

  it("throws for a key outside 400 to 599", () => {
    const entry: StatusOverride = {
      status: "not_sent",
      reason: "rejected",
      source: "https://x.test",
    };
    expect(() => defineStatusMap({ 200: entry })).toThrow(RangeError);
    expect(() => defineStatusMap({ 302: entry })).toThrow(RangeError);
  });

  it("throws for an override that tries to give sent", () => {
    const entry = { status: "sent", reason: "rejected", source: "https://x.test" };
    expect(() => defineStatusMap({ 500: entry as unknown as StatusOverride })).toThrow(/status/);
  });

  it("throws at classification time for an unchecked map without a source", () => {
    const map = { 503: { status: "not_sent", reason: "provider_error" } } as unknown as Record<
      number,
      StatusOverride
    >;
    expect(() => classifyResponse(503, null, map)).toThrow(/source/);
  });
});

describe("classifyThrown", () => {
  it("gives unknown/timeout for a timeout", () => {
    expect(classifyThrown(new Error("x"), { timedOut: true })).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(classifyThrown(timeout)).toMatchObject({ status: "unknown", reason: "timeout" });
  });

  it("gives unknown/network for any other thrown error", () => {
    for (const error of [new TypeError("fetch failed"), new Error("reset"), "text", null]) {
      expect(classifyThrown(error)).toMatchObject({ status: "unknown", reason: "network" });
    }
  });

  it("does not copy the error text into the message", () => {
    const result = classifyThrown(new TypeError("token=sk_live_123"));
    expect(JSON.stringify(result)).not.toContain("sk_live_123");
  });

  it("strips the query string and credentials from the URL", () => {
    const result = classifyThrown(new TypeError("x"), {
      url: "https://user:pw@api.example.com/v3/send?key=secret#frag",
    });
    const text = JSON.stringify(result);
    expect(text).toContain("https://api.example.com/v3/send");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("pw");
    expect(text).not.toContain("frag");
  });
});

describe("redactUrl", () => {
  it("keeps the origin and the path", () => {
    expect(redactUrl("https://api.example.com/a/b?key=secret")).toBe("https://api.example.com/a/b");
  });

  it("strips the query from a relative or invalid URL", () => {
    expect(redactUrl("/v1/send?key=secret")).toBe("/v1/send");
    expect(redactUrl("//user:pw@host/x#y")).toBe("//host/x");
  });
});
