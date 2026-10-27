import { describe, expect, it } from "vitest";
import { catalog, getProviderMeta } from "../../src/catalog/index";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import type { FetchLike } from "../../src/internal/http";
import { classifyHttp, parseStatusRules } from "../../src/providers/http/classify";
import { checkRequestUrl, isIpv4Like, parseAllowHosts } from "../../src/providers/http/hosts";
import {
  type HttpProviderOptions,
  httpMeta,
  httpProvider,
  RESERVED_PROVIDER_IDS,
} from "../../src/providers/http/index";

const SEND_URL = "https://api.acme.test/v1/send";
const VERIFY_URL = "https://api.acme.test/v1/me";
const KEY = "test-acme-key-not-real";
const NOW = Date.parse("2026-10-27T12:00:00.000Z");

type Answer = Response | "timeout" | "network" | ((url: string) => Response);

interface Recorder {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
}

function recorder(answer: Answer): Recorder {
  const calls: Recorder["calls"] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (answer === "timeout") {
      throw new DOMException(`Timed out: ${url} ${KEY}`, "TimeoutError");
    }
    if (answer === "network") throw new TypeError(`fetch failed: ${url} ${KEY}`);
    return typeof answer === "function" ? answer(url) : answer;
  };
  return { fetch: fetcher, calls };
}

function context(rec: Recorder): SendContext {
  return { fetch: rec.fetch, timeoutMs: 5_000, credentials: { apiKey: KEY }, now: NOW };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: "Acme <billing@example.com>",
    to: ["ana@example.org"],
    subject: "Your invoice",
    text: "Invoice attached.",
    ...overrides,
  };
}

function options(overrides: Partial<HttpProviderOptions> = {}): HttpProviderOptions {
  return {
    id: "acme-mail",
    name: "Acme Mail",
    credentialFields: [{ name: "apiKey", label: "API key", secret: true, required: true }],
    capabilities: {
      attachments: true,
      maxMessageBytes: null,
      cc: false,
      bcc: false,
      replyTo: false,
      customHeaders: false,
    },
    buildRequest: (msg, ctx) => ({
      url: SEND_URL,
      headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
      body: { to: msg.to, subject: msg.subject, text: msg.text ?? null },
    }),
    verifyRequest: (ctx) => ({
      url: VERIFY_URL,
      headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
    }),
    idFrom: "id",
    allowHosts: ["api.acme.test"],
    ...overrides,
  };
}

async function sendWith(answer: Answer, overrides: Partial<HttpProviderOptions> = {}) {
  const rec = recorder(answer);
  const result = await httpProvider(options(overrides)).send(message(), context(rec));
  return { result, rec };
}

describe("httpProvider: send", () => {
  it("posts the built body and reads the id with idFrom", async () => {
    const { result, rec } = await sendWith(json(200, { id: "m1" }));
    expect(result).toEqual({ status: "sent", provider: "acme-mail", providerMessageId: "m1" });
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      to: ["ana@example.org"],
      subject: "Your invoice",
      text: "Invoice attached.",
    });
  });

  it("gives sent with no id for a 202 with an empty body", async () => {
    const { result } = await sendWith(new Response(null, { status: 202 }));
    expect(result).toEqual({ status: "sent", provider: "acme-mail" });
    expect(result).not.toHaveProperty("providerMessageId");
  });

  it("gives sent with no id for a 2xx body that is not JSON, because the provider accepted", async () => {
    const { result } = await sendWith(new Response("<html>ok</html>", { status: 200 }));
    expect(result).toEqual({ status: "sent", provider: "acme-mail" });
  });

  it("reads a nested dot path and an array index", async () => {
    const { result } = await sendWith(json(200, { data: { ids: ["m7", "m8"] } }), {
      idFrom: "data.ids.0",
    });
    expect(result).toMatchObject({ status: "sent", providerMessageId: "m7" });
  });

  it("does not read an inherited field with a dot path", async () => {
    const { result } = await sendWith(json(200, {}), { idFrom: "constructor" });
    expect(result).toEqual({ status: "sent", provider: "acme-mail" });
  });

  it("reads the id with a function, and gives no id when the function throws", async () => {
    const good = await sendWith(json(200, {}, { "x-message-id": "h1" }), {
      idFrom: (_body, headers) => headers.get("x-message-id") ?? undefined,
    });
    expect(good.result).toMatchObject({ status: "sent", providerMessageId: "h1" });
    const bad = await sendWith(json(200, {}), {
      idFrom: () => {
        throw new Error("boom");
      },
    });
    expect(bad.result).toEqual({ status: "sent", provider: "acme-mail" });
  });

  it("sends a string body unchanged, with the method that buildRequest gives", async () => {
    const { rec } = await sendWith(json(200, { id: "m1" }), {
      buildRequest: () => ({ url: SEND_URL, method: "PUT", body: "raw=1" }),
    });
    expect(rec.calls[0]?.init.method).toBe("PUT");
    expect(rec.calls[0]?.init.body).toBe("raw=1");
    expect(new Headers(rec.calls[0]?.init.headers).has("content-type")).toBe(false);
  });

  it("refuses a message that needs a capability the options do not declare, with no request", async () => {
    const rec = recorder(json(200, {}));
    const result = await httpProvider(options()).send(
      message({ cc: ["bo@example.org"] }),
      context(rec),
    );
    expect(result).toMatchObject({ status: "not_sent", reason: "unsupported" });
    expect(rec.calls).toHaveLength(0);
  });

  it("gives not_sent with no request when buildRequest throws, and drops the error text", async () => {
    const { result, rec } = await sendWith(json(200, {}), {
      buildRequest: () => {
        throw new Error(`bad ${KEY}`);
      },
    });
    expect(result).toMatchObject({ status: "not_sent", reason: "invalid_message" });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(rec.calls).toHaveLength(0);
  });

  it("refuses a bad method, a GET body, and a bad header, with no request", async () => {
    const cases: HttpProviderOptions["buildRequest"][] = [
      () => ({ url: SEND_URL, method: "TRACE" }),
      () => ({ url: SEND_URL, method: "GET", body: "x" }),
      () => ({ url: SEND_URL, headers: { "bad name": "x" } }),
    ];
    for (const buildRequest of cases) {
      const { result, rec } = await sendWith(json(200, {}), { buildRequest });
      expect(result).toMatchObject({ status: "not_sent", reason: "invalid_message" });
      expect(rec.calls).toHaveLength(0);
    }
  });
});

describe("httpProvider: base table", () => {
  it.each([
    [400, "invalid_message"],
    [401, "auth"],
    [402, "credits"],
    [403, "auth"],
    [413, "invalid_message"],
    [415, "invalid_message"],
    [422, "invalid_message"],
  ])("maps %i to not_sent/%s", async (status, reason) => {
    const { result } = await sendWith(json(status, { error: "x" }));
    expect(result).toMatchObject({ status: "not_sent", reason, httpStatus: status });
  });

  it("maps 429 to not_sent/rate_limited with retryAfterMs", async () => {
    const { result } = await sendWith(json(429, {}, { "retry-after": "2" }));
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 2000,
    });
  });

  it.each([
    301, 302, 303, 307, 308, 404, 405, 408, 409, 410, 418, 451, 499, 500, 502, 503, 504, 599,
  ])("keeps %i unknown by default", async (status) => {
    const body = status >= 300 && status < 400 ? null : "{}";
    const headers: Record<string, string> =
      status >= 300 && status < 400 ? { location: "https://evil.example/" } : {};
    const { result, rec } = await sendWith(new Response(body, { status, headers }));
    expect(result).toMatchObject({
      status: "unknown",
      reason: "provider_error",
      httpStatus: status,
    });
    // No redirect is followed: one request, with redirect manual.
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.init.redirect).toBe("manual");
  });

  it("keeps a timeout and a thrown fetch unknown, with no URL and no key in the message", async () => {
    const timeout = await sendWith("timeout");
    expect(timeout.result).toMatchObject({ status: "unknown", reason: "timeout" });
    const network = await sendWith("network");
    expect(network.result).toMatchObject({ status: "unknown", reason: "network" });
    for (const result of [timeout.result, network.result]) {
      expect(JSON.stringify(result)).not.toContain("api.acme.test");
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it("classifies a status outside 200 to 599 as unknown", () => {
    const rules = parseStatusRules([404], undefined, "");
    for (const status of [0, 100, 199, 600, 999, -1, 404.5]) {
      expect(classifyHttp(status, null, rules, NOW)).toMatchObject({ status: "unknown" });
    }
  });
});

describe("httpProvider: notSentStatuses and unknownStatuses (R8)", () => {
  it("makes a 404 not_sent/rejected with notSentStatuses, and unknown without it", async () => {
    const opted = await sendWith(json(404, {}), { notSentStatuses: [404] });
    expect(opted.result).toMatchObject({ status: "not_sent", reason: "rejected" });
    const plain = await sendWith(json(404, {}));
    expect(plain.result).toMatchObject({ status: "unknown" });
  });

  it("makes a 422 unknown with unknownStatuses, and any other 4xx too", async () => {
    const result422 = await sendWith(json(422, {}), { unknownStatuses: [422] });
    expect(result422.result).toMatchObject({ status: "unknown", httpStatus: 422 });
    const result401 = await sendWith(json(401, {}), { unknownStatuses: [401] });
    expect(result401.result).toMatchObject({ status: "unknown", httpStatus: 401 });
  });

  it.each([
    [[500]],
    [[302]],
    [[408]],
    [[409]],
    [[503, 404]],
    [[399]],
    [[600]],
    [[404.5]],
    [["404"]],
    [[Number.NaN]],
  ])("throws TypeError at setup for notSentStatuses %j", (list) => {
    expect(() =>
      httpProvider(options({ notSentStatuses: list as unknown as readonly number[] })),
    ).toThrow(TypeError);
  });

  it("throws for a notSentStatuses that is not an array", () => {
    expect(() =>
      httpProvider(options({ notSentStatuses: 404 as unknown as readonly number[] })),
    ).toThrow(TypeError);
  });

  it("throws for an unknownStatuses entry outside 400 to 499, and for a code in both lists", () => {
    expect(() => httpProvider(options({ unknownStatuses: [500] }))).toThrow(TypeError);
    expect(() => httpProvider(options({ unknownStatuses: [302] }))).toThrow(TypeError);
    expect(() => httpProvider(options({ notSentStatuses: [404], unknownStatuses: [404] }))).toThrow(
      TypeError,
    );
  });

  it("allows 408 and 409 in unknownStatuses, which changes nothing", async () => {
    const { result } = await sendWith(json(409, {}), { unknownStatuses: [408, 409] });
    expect(result).toMatchObject({ status: "unknown" });
  });
});

describe("httpProvider: classify hook (R8)", () => {
  it("turns a hook answer of not_sent for a 503 into unknown", async () => {
    const { result } = await sendWith(json(503, {}), {
      classify: () => ({ status: "not_sent", reason: "rejected" }),
    });
    expect(result).toMatchObject({ status: "unknown", httpStatus: 503 });
  });

  it.each([302, 408, 409, 500, 504])(
    "turns a hook answer of not_sent for %i into unknown",
    async (status) => {
      const { result } = await sendWith(new Response(null, { status }), {
        classify: () => ({ status: "not_sent", reason: "auth" }),
      });
      expect(result).toMatchObject({ status: "unknown", httpStatus: status });
    },
  );

  it("turns a hook answer of not_sent for a code in unknownStatuses into unknown", async () => {
    const { result } = await sendWith(json(422, {}), {
      unknownStatuses: [422],
      classify: () => ({ status: "not_sent", reason: "invalid_message" }),
    });
    expect(result).toMatchObject({ status: "unknown" });
  });

  it("turns a hook answer of not_sent for a 2xx into unknown", async () => {
    const { result } = await sendWith(json(200, { id: "m1" }), {
      classify: () => ({ status: "not_sent", reason: "rejected" }),
    });
    expect(result).toMatchObject({ status: "unknown", httpStatus: 200 });
  });

  it("turns a hook answer of sent for a non-2xx code into unknown", async () => {
    for (const status of [302, 404, 500]) {
      const { result } = await sendWith(new Response(null, { status }), {
        classify: () => ({ status: "sent" }),
      });
      expect(result).toMatchObject({ status: "unknown", httpStatus: status });
    }
  });

  it("turns a hook that throws, a bad answer shape, and a bad reason into unknown", async () => {
    const hooks: HttpProviderOptions["classify"][] = [
      () => {
        throw new Error("boom");
      },
      () => "not_sent" as never,
      () => ({ status: "not_sent", reason: "provider_error" }),
      () => ({ status: "not_sent", reason: "timeout" }),
      () => ({ status: "maybe" }) as never,
    ];
    for (const classify of hooks) {
      const { result } = await sendWith(json(404, {}), { classify, notSentStatuses: [404] });
      expect(result).toMatchObject({ status: "unknown", httpStatus: 404 });
    }
  });

  it("lets a hook give not_sent for an allowed 4xx, and read the body", async () => {
    const { result } = await sendWith(json(404, { code: "suppressed" }), {
      classify: ({ status, body, operation }) =>
        operation === "send" &&
        status === 404 &&
        (body as { code?: string } | null)?.code === "suppressed"
          ? { status: "not_sent", reason: "rejected" }
          : undefined,
    });
    expect(result).toMatchObject({ status: "not_sent", reason: "rejected", httpStatus: 404 });
  });

  it("lets a hook make a 2xx unknown, and keeps the table when it answers undefined", async () => {
    const odd = await sendWith(json(200, { ok: false }), {
      classify: () => ({ status: "unknown" }),
    });
    expect(odd.result).toMatchObject({ status: "unknown", httpStatus: 200 });
    const kept = await sendWith(json(401, {}), { classify: () => undefined });
    expect(kept.result).toMatchObject({ status: "not_sent", reason: "auth" });
  });

  it("gives a hook not_sent/rate_limited the Retry-After value", async () => {
    const { result } = await sendWith(json(420, {}, { "retry-after": "3" }), {
      classify: () => ({ status: "not_sent", reason: "rate_limited" }),
    });
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "rate_limited",
      retryAfterMs: 3000,
    });
  });
});

describe("httpProvider: host rules at send time (R9)", () => {
  it.each([
    "https://other.example/v1/send",
    "http://api.acme.test/v1/send",
    "https://127.0.0.1/v1/send",
    "https://[::1]/v1/send",
    "https://user:pass@api.acme.test/v1/send",
    "https://api.acme.test:8443/v1/send",
    "https://localhost/v1/send",
    "not a url",
  ])("gives not_sent/unsupported with no fetch for %s", async (url) => {
    const { result, rec } = await sendWith(json(200, {}), {
      buildRequest: () => ({ url, body: "{}" }),
    });
    expect(result).toMatchObject({ status: "not_sent", reason: "unsupported" });
    expect(rec.calls).toHaveLength(0);
    // The result never echoes the URL.
    expect(JSON.stringify(result)).not.toContain(url);
  });

  it("applies the host rules with no allowHosts", async () => {
    for (const url of ["https://127.0.0.1/", "https://2130706433/", "https://api.internal/"]) {
      const { result, rec } = await sendWith(json(200, {}), {
        allowHosts: undefined,
        buildRequest: () => ({ url }),
      });
      expect(result).toMatchObject({ status: "not_sent", reason: "unsupported" });
      expect(rec.calls).toHaveLength(0);
    }
    const open = await sendWith(json(200, { id: "m1" }), { allowHosts: undefined });
    expect(open.result).toMatchObject({ status: "sent" });
  });

  it("allows a port that an allowHosts entry names", async () => {
    const { result, rec } = await sendWith(json(200, { id: "m1" }), {
      allowHosts: ["api.acme.test:8443"],
      buildRequest: () => ({ url: "https://api.acme.test:8443/v1/send", body: "{}" }),
    });
    expect(result).toMatchObject({ status: "sent", providerMessageId: "m1" });
    expect(rec.calls[0]?.url).toBe("https://api.acme.test:8443/v1/send");
  });

  it("allows a query string in a code-API URL", async () => {
    const { result, rec } = await sendWith(json(200, { id: "m1" }), {
      buildRequest: () => ({ url: `${SEND_URL}?dry-run=true`, body: "{}" }),
    });
    expect(result).toMatchObject({ status: "sent" });
    expect(rec.calls[0]?.url).toBe(`${SEND_URL}?dry-run=true`);
  });

  it.each([
    [[]],
    [["*"]],
    [["*.acme.test"]],
    [["127.0.0.1"]],
    [["localhost"]],
    [["api.acme.test/x"]],
    [["api.acme.test:99999"]],
    [[42]],
  ])("throws TypeError at setup for allowHosts %j", (list) => {
    expect(() =>
      httpProvider(options({ allowHosts: list as unknown as readonly string[] })),
    ).toThrow(TypeError);
  });

  it("throws for an allowHosts that is not an array", () => {
    expect(() =>
      httpProvider(options({ allowHosts: "api.acme.test" as unknown as readonly string[] })),
    ).toThrow(TypeError);
  });
});

describe("httpProvider: verify", () => {
  async function verifyWith(answer: Answer, overrides: Partial<HttpProviderOptions> = {}) {
    const rec = recorder(answer);
    const result = await httpProvider(options(overrides)).verify(context(rec));
    return { result, rec };
  }

  it("sends the verify request with the credential, and a 2xx is ok", async () => {
    const { result, rec } = await verifyWith(json(200, {}));
    expect(result).toEqual({ ok: true });
    expect(rec.calls[0]?.url).toBe(VERIFY_URL);
    expect(rec.calls[0]?.init.method).toBe("GET");
    expect(rec.calls[0]?.init.redirect).toBe("manual");
    expect(new Headers(rec.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("maps a 401 to not_sent/auth", async () => {
    const { result } = await verifyWith(json(401, {}));
    expect(result).toMatchObject({ ok: false, status: "not_sent", reason: "auth" });
  });

  it("is not ok for a 302, and follows no redirect", async () => {
    const { result, rec } = await verifyWith(
      new Response(null, { status: 302, headers: { location: "https://api.acme.test/" } }),
    );
    expect(result).toMatchObject({ ok: false, status: "unknown", httpStatus: 302 });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.init.redirect).toBe("manual");
  });

  it("is not ok with no fetch for a verify URL outside allowHosts", async () => {
    const { result, rec } = await verifyWith(json(200, {}), {
      verifyRequest: () => ({ url: "https://other.example/me" }),
    });
    expect(result).toMatchObject({ ok: false, status: "not_sent", reason: "unsupported" });
    expect(rec.calls).toHaveLength(0);
  });

  it("keeps a 503, a timeout, and a thrown fetch unknown", async () => {
    for (const answer of [json(503, {}), "timeout", "network"] as Answer[]) {
      const { result } = await verifyWith(answer);
      expect(result).toMatchObject({ ok: false, status: "unknown" });
    }
  });
});

describe("httpProvider: options", () => {
  it("builds tier 2 meta with the given id, fields, and capabilities", () => {
    const adapter = httpProvider(
      options({ capabilities: { ...options().capabilities, cc: true, maxRecipients: 5 } }),
    );
    expect(adapter.meta).toMatchObject({
      id: "acme-mail",
      name: "Acme Mail",
      tier: 2,
      webhooks: false,
      nativeIdempotency: false,
    });
    expect(adapter.meta.capabilities).toMatchObject({
      attachments: true,
      cc: true,
      idempotency: false,
      batchSize: 1,
      maxRecipients: 5,
    });
    expect(adapter.meta.credentialFields.map((field) => field.name)).toEqual(["apiKey"]);
    expect(getProviderMeta("acme-mail")).toBeUndefined();
  });

  it("throws for the id of a built-in provider, such as resend", () => {
    expect(() => httpProvider(options({ id: "resend" }))).toThrow(/built-in provider/);
    expect(() => httpProvider(options({ id: "http" }))).toThrow(TypeError);
  });

  it.each(["", "Acme", "1acme", "a", "acme_mail", `a${"b".repeat(32)}`])(
    "throws for the id %j",
    (id) => {
      expect(() => httpProvider(options({ id }))).toThrow(TypeError);
    },
  );

  it("throws without a required secret credential field", () => {
    expect(() => httpProvider(options({ credentialFields: [] }))).toThrow(TypeError);
    expect(() =>
      httpProvider(
        options({
          credentialFields: [{ name: "apiKey", label: "API key", secret: false, required: true }],
        }),
      ),
    ).toThrow(TypeError);
  });

  it("throws for bad capabilities, functions, idFrom, and docsUrl", () => {
    const caps = options().capabilities;
    const bad: Partial<HttpProviderOptions>[] = [
      { capabilities: { ...caps, attachments: false as true } },
      { capabilities: { ...caps, cc: "yes" as unknown as boolean } },
      { capabilities: { ...caps, maxMessageBytes: -1 } },
      { capabilities: { ...caps, maxRecipients: 0 } },
      { buildRequest: undefined as never },
      { verifyRequest: undefined as never },
      { idFrom: "a..b" },
      { idFrom: 42 as never },
      { classify: "x" as never },
      { docsUrl: "http://docs.example" },
      { name: "" },
    ];
    for (const item of bad) expect(() => httpProvider(options(item))).toThrow(TypeError);
  });
});

describe("host rules", () => {
  it.each([
    "http://api.acme.test/",
    "ftp://api.acme.test/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0177.0.0.1/",
    "https://127.1/",
    "https://0x7f.0.0.1/",
    "https://%31%32%37.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[fd00::1]/",
    "https://localhost/",
    "https://localhost./",
    "https://LOCALHOST/",
    "https://app.localhost/",
    "https://printer.local/",
    "https://api.internal/",
    "https://metadata.google.internal/",
    "https://intranet/",
    "https://api..acme.test/",
    "https://user:pass@api.acme.test/",
    "https://user@api.acme.test/",
    "https://@api.acme.test/",
    "https://api.acme.test:8443/",
    " https://api.acme.test/",
    "https://api.acme.test/\n",
    "https://api.acme\t.test/",
    "https:///",
    "",
  ])("refuses %j", (url) => {
    expect(checkRequestUrl(url).ok).toBe(false);
  });

  it.each([
    "https://api.acme.test/v1/send",
    "https://API.Acme.Test./v1/send",
    "https://api.acme.test:443/v1/send",
    "https://1e100.example/",
  ])("accepts %j", (url) => {
    expect(checkRequestUrl(url).ok).toBe(true);
  });

  it("refuses a query string and a fragment only when asked", () => {
    expect(checkRequestUrl("https://api.acme.test/?a=1").ok).toBe(true);
    expect(checkRequestUrl("https://api.acme.test/?a=1", { refuseQuery: true }).ok).toBe(false);
    expect(checkRequestUrl("https://api.acme.test/#x", { refuseQuery: true }).ok).toBe(false);
    expect(checkRequestUrl("https://api.acme.test/?", { refuseQuery: true }).ok).toBe(false);
  });

  it("matches allowHosts exactly, after normalization", () => {
    const allowHosts = parseAllowHosts(["API.acme.test.", "mail.acme.test:8443"], "allowHosts");
    expect(checkRequestUrl("https://api.acme.test/", { allowHosts }).ok).toBe(true);
    expect(checkRequestUrl("https://api.acme.test./", { allowHosts }).ok).toBe(true);
    expect(checkRequestUrl("https://x.api.acme.test/", { allowHosts }).ok).toBe(false);
    expect(checkRequestUrl("https://acme.test/", { allowHosts }).ok).toBe(false);
    expect(checkRequestUrl("https://mail.acme.test:8443/", { allowHosts }).ok).toBe(true);
    expect(checkRequestUrl("https://mail.acme.test/", { allowHosts }).ok).toBe(false);
    expect(checkRequestUrl("https://api.acme.test:8443/", { allowHosts }).ok).toBe(false);
  });

  it("reads every IPv4 form as an address", () => {
    for (const host of ["1.2.3.4", "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "1.2.3.4."]) {
      expect(isIpv4Like(host)).toBe(true);
    }
    for (const host of ["api.acme.test", "1e100.net", "10.example"]) {
      expect(isIpv4Like(host)).toBe(false);
    }
  });

  it("names the field in an allowHosts error, never the entry", () => {
    expect(() => parseAllowHosts(["127.0.0.1"], "allowHosts")).toThrow(/^allowHosts\[0\]/);
    try {
      parseAllowHosts(["secret-host.internal"], "allowHosts");
    } catch (error) {
      expect(String(error)).not.toContain("secret-host");
    }
  });
});

describe("generic provider catalog entry", () => {
  it("lists http at tier 2 with one secret token field", () => {
    expect(getProviderMeta("http")).toBe(httpMeta);
    expect(httpMeta.tier).toBe(2);
    expect(httpMeta.credentialFields).toEqual([
      expect.objectContaining({ name: "token", secret: true, required: true }),
    ]);
  });

  it("reserves every catalog id, so the reserved list stays in step", () => {
    expect([...RESERVED_PROVIDER_IDS].sort()).toEqual(catalog.map((meta) => meta.id).sort());
  });
});
