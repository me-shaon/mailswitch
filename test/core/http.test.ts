import { describe, expect, it } from "vitest";
import { classifyResponse } from "../../src/core/classify";
import {
  callProvider,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  parseBaseUrl,
  readJson,
  withProvider,
} from "../../src/internal/http";
import { cloudflareRest } from "../../src/providers/cloudflare/index";
import { mailgun } from "../../src/providers/mailgun/index";
import { postmark } from "../../src/providers/postmark/index";
import { resend } from "../../src/providers/resend/index";
import { ses } from "../../src/providers/ses/index";
import { tosend } from "../../src/providers/tosend/index";

const API_KEY = "re_live_9f8e7d6c5b4a";

function respond(status: number, body: string, headers: HeadersInit = {}): FetchLike {
  return async () => new Response(body, { status, headers });
}

// A fetch that never answers, and rejects when its signal aborts, as a real fetch does.
const hangingFetch: FetchLike = (_input, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("callProvider", () => {
  it("returns the response and passes the request through", async () => {
    let seen: { input: string; init: RequestInit } | undefined;
    const call = await callProvider({
      url: "https://api.example.com/send",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: "{}",
      fetch: async (input, init) => {
        seen = { input, init };
        return new Response("ok", { status: 202 });
      },
    });
    expect(call.ok).toBe(true);
    expect(seen?.input).toBe("https://api.example.com/send");
    expect(seen?.init.method).toBe("POST");
    expect(seen?.init.body).toBe("{}");
    expect(seen?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes redirect to fetch only when it is set", async () => {
    const inits: RequestInit[] = [];
    const fetch: FetchLike = async (_input, init) => {
      inits.push(init);
      return new Response(null, { status: 302, headers: { location: "https://example.com/" } });
    };
    const manual = await callProvider({
      url: "https://api.example.com/send",
      redirect: "manual",
      fetch,
    });
    await callProvider({ url: "https://api.example.com/send", fetch });
    expect(manual.ok && manual.response.status).toBe(302);
    expect(inits[0]?.redirect).toBe("manual");
    expect(inits[1]).not.toHaveProperty("redirect");
  });

  it("uses a 15 second default timeout", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  it("gives unknown/timeout when the timeout fires", async () => {
    const call = await callProvider({
      url: "https://api.example.com/send?key=secret",
      timeoutMs: 10,
      fetch: hangingFetch,
    });
    expect(call).toMatchObject({ ok: false, result: { status: "unknown", reason: "timeout" } });
    expect(JSON.stringify(call)).not.toContain("secret");
  });

  it("gives unknown/network for any thrown fetch error", async () => {
    const call = await callProvider({
      url: "https://api.example.com/send?key=secret",
      fetch: async () => {
        throw new TypeError(`Network connection lost for key ${API_KEY}`);
      },
    });
    expect(call).toMatchObject({ ok: false, result: { status: "unknown", reason: "network" } });
    const text = JSON.stringify(call);
    expect(text).not.toContain("secret");
    expect(text).not.toContain(API_KEY);
    expect(text).toContain("https://api.example.com/send");
  });

  it("throws for an invalid timeout", async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        callProvider({ url: "https://x.test", timeoutMs, fetch: respond(200, "") }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("does not put a body that echoes the API key into the result", async () => {
    const body = JSON.stringify({ error: `Invalid API key ${API_KEY}`, key: API_KEY });
    const call = await callProvider({
      url: `https://api.example.com/send?key=${API_KEY}`,
      fetch: respond(401, body, { "content-type": "application/json" }),
    });
    if (!call.ok) throw new Error("expected a response");
    const result = classifyResponse(call.response.status, call.response.headers);
    expect(result).toMatchObject({ status: "not_sent", reason: "auth", httpStatus: 401 });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });
});

describe("readJson", () => {
  it("parses a JSON body", async () => {
    expect(await readJson(new Response('{"id":"m_1"}'))).toEqual({ id: "m_1" });
  });

  it("returns null for an empty, an invalid, or a used body", async () => {
    expect(await readJson(new Response(""))).toBeNull();
    expect(await readJson(new Response("<html>"))).toBeNull();
    const used = new Response("{}");
    await used.text();
    expect(await readJson(used)).toBeNull();
  });
});

describe("withProvider", () => {
  it("returns a copy with the provider id", () => {
    const input = { status: "unknown" as const, reason: "network" as const, message: "m" };
    const out = withProvider(input, "resend");
    expect(out).toEqual({ ...input, provider: "resend" });
    expect(out).not.toBe(input);
    expect(input).not.toHaveProperty("provider");
  });
});

describe("parseBaseUrl", () => {
  it("returns the fallback when the value is undefined", () => {
    expect(parseBaseUrl(undefined, "https://api.example.com", "x: baseUrl")).toBe(
      "https://api.example.com",
    );
    expect(parseBaseUrl(undefined, undefined, "x: baseUrl")).toBeUndefined();
  });

  it("accepts https and removes trailing slashes", () => {
    expect(parseBaseUrl("https://proxy.example/v4//", undefined, "x")).toBe(
      "https://proxy.example/v4",
    );
  });

  it("accepts http only on a loopback host", () => {
    for (const value of ["http://localhost:8787", "http://127.0.0.1:1", "http://[::1]:9"]) {
      expect(parseBaseUrl(value, undefined, "x")).toBe(value);
    }
    expect(() => parseBaseUrl("http://api.example.com", undefined, "x")).toThrow(TypeError);
    expect(() => parseBaseUrl("http://localhost.example.com", undefined, "x")).toThrow(TypeError);
  });

  it("refuses credentials, a query, a fragment, other schemes, and non-strings", () => {
    for (const value of [
      "https://user:pass@api.example.com",
      "https://api.example.com/?a=1",
      "https://api.example.com/?",
      "https://api.example.com/#x",
      "ftp://api.example.com",
      "not a url",
      "",
      42,
      null,
    ]) {
      expect(() => parseBaseUrl(value, undefined, "x: baseUrl")).toThrow(/^x: baseUrl must be/);
    }
  });

  it("gives every HTTP adapter the same rules", () => {
    const factories: ((baseUrl: string) => unknown)[] = [
      (baseUrl) => resend({ baseUrl }),
      (baseUrl) => tosend({ baseUrl }),
      (baseUrl) => postmark({ baseUrl }),
      (baseUrl) => mailgun({ baseUrl }),
      (baseUrl) => cloudflareRest({ baseUrl }),
      (endpoint) => ses({ endpoint }),
    ];
    for (const create of factories) {
      expect(() => create("https://proxy.example/")).not.toThrow();
      expect(() => create("http://127.0.0.1:8787")).not.toThrow();
      expect(() => create("http://proxy.example")).toThrow(TypeError);
      expect(() => create("https://key@proxy.example")).toThrow(TypeError);
      expect(() => create("https://proxy.example/?key=1")).toThrow(TypeError);
    }
  });
});
