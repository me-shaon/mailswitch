import { describe, expect, it } from "vitest";
import { getProviderMeta } from "../../src/catalog/index";
import {
  HTTP_FIXTURE_ALLOW_HOSTS,
  HTTP_FIXTURE_TOKEN,
  HTTP_SEND_URL,
  HTTP_VERIFY_URL,
  httpFixtureConfig,
} from "../../src/conformance/fixtures/http";
import type { SendContext } from "../../src/core/adapter";
import type { OutgoingMessage } from "../../src/core/types";
import { basicAuthorization, bytesToBase64, utf8 } from "../../src/internal/encoding";
import type { FetchLike } from "../../src/internal/http";
import { type HttpProviderConfig, httpProviderFromConfig } from "../../src/providers/http/index";

const TOKEN = HTTP_FIXTURE_TOKEN;
const ALLOW = HTTP_FIXTURE_ALLOW_HOSTS;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
/** A value that must never reach an error message. */
const SECRET = "sk-live-not-real-but-secret";

interface Recorder {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
}

function recorder(answer: () => Response): Recorder {
  const calls: Recorder["calls"] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetch: fetcher, calls };
}

function context(rec: Recorder): SendContext {
  return { fetch: rec.fetch, timeoutMs: 5_000, credentials: { token: TOKEN }, now: NOW };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function config(overrides: Record<string, unknown> = {}): HttpProviderConfig {
  return { ...httpFixtureConfig(), ...overrides } as HttpProviderConfig;
}

function build(overrides: Record<string, unknown> = {}) {
  return httpProviderFromConfig(config(overrides), { allowHosts: ALLOW });
}

function full(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    from: { email: "billing@example.com", name: "Acme Billing" },
    to: ["Ana <ana@example.org>", "bo@example.org"],
    cc: ["cy@example.org"],
    bcc: ["di@example.org"],
    replyTo: "help@example.com",
    subject: "Your invoice",
    html: "<p>Invoice attached.</p>",
    text: "Invoice attached.",
    headers: { "X-Invoice": "42" },
    attachments: [
      { filename: "a.txt", content: utf8("hi"), contentType: "text/plain" },
      { filename: "logo.png", content: "aGk=", contentType: "image/png", contentId: "logo" },
    ],
    ...overrides,
  };
}

function sentBody(rec: Recorder, index = 0): Record<string, unknown> {
  return JSON.parse(String(rec.calls[index]?.init.body)) as Record<string, unknown>;
}

/** Expects a TypeError whose message holds none of the given values. */
function refused(run: () => unknown, ...hidden: string[]): string {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TypeError);
  const text = String((caught as Error).message);
  for (const value of [SECRET, TOKEN, ...hidden]) expect(text).not.toContain(value);
  return text;
}

describe("httpProviderFromConfig: send", () => {
  it("sends the mapped body with bearer auth and reads the id with idFrom", async () => {
    const rec = recorder(json(200, { data: { messageId: "msg-9" } }));
    const result = await build().send(full(), context(rec));
    expect(result).toEqual({ status: "sent", provider: "examplemail", providerMessageId: "msg-9" });
    const call = rec.calls[0];
    expect(call?.url).toBe(HTTP_SEND_URL);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(sentBody(rec)).toEqual({
      from: { email: "billing@example.com", name: "Acme Billing" },
      to: [{ email: "ana@example.org", name: "Ana" }, { email: "bo@example.org" }],
      cc: [{ email: "cy@example.org" }],
      bcc: [{ email: "di@example.org" }],
      reply_to: { email: "help@example.com" },
      subject: "Your invoice",
      html: "<p>Invoice attached.</p>",
      text: "Invoice attached.",
      headers: { "X-Invoice": "42" },
      attachments: [
        { name: "a.txt", data: bytesToBase64(utf8("hi")), type: "text/plain" },
        { name: "logo.png", data: "aGk=", type: "image/png", cid: "logo" },
      ],
    });
  });

  it("sends the exact request bytes and headers for send and verify", async () => {
    const rec = recorder(json(200, {}));
    const adapter = build({ requestHeaders: { "X-Api-Version": "2" } });
    const message = full({ cc: [], bcc: [], headers: {}, attachments: [] });
    await adapter.send(message, context(rec));
    await adapter.verify(context(rec));
    expect(rec.calls[0]?.init.body).toBe(
      JSON.stringify({
        from: { email: "billing@example.com", name: "Acme Billing" },
        to: [{ email: "ana@example.org", name: "Ana" }, { email: "bo@example.org" }],
        reply_to: { email: "help@example.com" },
        subject: "Your invoice",
        html: "<p>Invoice attached.</p>",
        text: "Invoice attached.",
      }),
    );
    expect([...new Headers(rec.calls[0]?.init.headers)]).toEqual([
      ["accept", "application/json"],
      ["authorization", `Bearer ${TOKEN}`],
      ["content-type", "application/json"],
      ["x-api-version", "2"],
    ]);
    expect([...new Headers(rec.calls[1]?.init.headers)]).toEqual([
      ["accept", "application/json"],
      ["authorization", `Bearer ${TOKEN}`],
      ["x-api-version", "2"],
    ]);
  });

  it("keeps a static content-type header", async () => {
    const rec = recorder(json(200, {}));
    const requestHeaders = { "Content-Type": "application/vnd.mail+json" };
    await build({ requestHeaders }).send(full(), context(rec));
    const headers = new Headers(rec.calls[0]?.init.headers);
    expect(headers.get("content-type")).toBe("application/vnd.mail+json");
  });

  it("uses the default attachment keys when the config has no attachment sub-map", async () => {
    const rec = recorder(json(200, {}));
    const base = httpFixtureConfig();
    delete base.attachmentFields;
    await httpProviderFromConfig(base, { allowHosts: ALLOW }).send(full(), context(rec));
    expect(sentBody(rec).attachments).toEqual([
      { filename: "a.txt", content: bytesToBase64(utf8("hi")), contentType: "text/plain" },
      { filename: "logo.png", content: "aGk=", contentType: "image/png", contentId: "logo" },
    ]);
  });

  it("renders the string address format as Name <email>", async () => {
    const rec = recorder(json(200, {}));
    await build({ addressFormat: "string" }).send(
      full({ from: "billing@example.com", to: [{ email: "ana@example.org", name: "Ana" }] }),
      context(rec),
    );
    const body = sentBody(rec);
    expect(body.to).toEqual(["Ana <ana@example.org>"]);
    expect(body.from).toBe("billing@example.com");
    expect(body.reply_to).toBe("help@example.com");
  });

  it("quotes a display name with a special character in the string format", async () => {
    const rec = recorder(json(200, {}));
    await build({ addressFormat: "string" }).send(
      full({ to: [{ email: "ana@example.org", name: "Ana, Acme" }] }),
      context(rec),
    );
    expect(sentBody(rec).to).toEqual(['"Ana, Acme" <ana@example.org>']);
  });

  it("takes the basic auth user name from the config and the password from the token", async () => {
    const rec = recorder(json(200, {}));
    await build({ auth: { type: "basic", username: "api" } }).send(full(), context(rec));
    expect(new Headers(rec.calls[0]?.init.headers).get("authorization")).toBe(
      basicAuthorization("api", TOKEN),
    );
  });

  it("puts the token in a named header", async () => {
    const rec = recorder(json(200, {}));
    await build({ auth: { type: "header", header: "X-Mail-Token" } }).send(full(), context(rec));
    const headers = new Headers(rec.calls[0]?.init.headers);
    expect(headers.get("x-mail-token")).toBe(TOKEN);
    expect(headers.has("authorization")).toBe(false);
  });

  it("sends static request headers, and sends PUT when the config says so", async () => {
    const rec = recorder(json(200, {}));
    await build({ method: "PUT", requestHeaders: { "X-Api-Version": "2" } }).send(
      full(),
      context(rec),
    );
    expect(rec.calls[0]?.init.method).toBe("PUT");
    expect(new Headers(rec.calls[0]?.init.headers).get("x-api-version")).toBe("2");
  });

  it("gives sent with no id for a 2xx with no id, an empty body, or a body that is not JSON", async () => {
    for (const answer of [
      json(200, { data: {} }),
      () => new Response(null, { status: 202 }),
      () => new Response("accepted", { status: 200 }),
    ]) {
      const rec = recorder(answer);
      const result = await build().send(full(), context(rec));
      expect(result).toEqual({ status: "sent", provider: "examplemail" });
    }
  });

  it("leaves optional parts out when the message has none", async () => {
    const rec = recorder(json(200, {}));
    await build().send(
      { from: "billing@example.com", to: ["ana@example.org"], subject: "Hi", text: "Hi" },
      context(rec),
    );
    expect(sentBody(rec)).toEqual({
      from: { email: "billing@example.com" },
      to: [{ email: "ana@example.org" }],
      subject: "Hi",
      text: "Hi",
    });
  });

  it("sets cc, bcc, replyTo, and customHeaders only when the field map names them", async () => {
    const base = httpFixtureConfig();
    const fields = {
      from: base.fields.from,
      to: base.fields.to,
      subject: base.fields.subject,
      text: "text",
      attachments: base.fields.attachments,
    };
    const adapter = build({ fields });
    expect(adapter.meta.capabilities).toMatchObject({
      attachments: true,
      cc: false,
      bcc: false,
      replyTo: false,
      customHeaders: false,
      idempotency: false,
      batchSize: 1,
    });
    expect(build().meta.capabilities).toMatchObject({
      cc: true,
      bcc: true,
      replyTo: true,
      customHeaders: true,
    });
    for (const extra of [
      { cc: ["cy@example.org"] },
      { bcc: ["di@example.org"] },
      { replyTo: "help@example.com" },
      { headers: { "X-A": "1" } },
      { html: "<p>Hi</p>" },
    ]) {
      const rec = recorder(json(200, {}));
      const result = await adapter.send(
        {
          from: "billing@example.com",
          to: ["ana@example.org"],
          subject: "Hi",
          text: "Hi",
          ...extra,
        },
        context(rec),
      );
      expect(result).toMatchObject({ status: "not_sent", reason: "unsupported" });
      expect(rec.calls).toHaveLength(0);
    }
  });

  it("applies notSentStatuses and unknownStatuses from the config", async () => {
    const opted = recorder(json(404, {}));
    expect(await build({ notSentStatuses: [404] }).send(full(), context(opted))).toMatchObject({
      status: "not_sent",
      reason: "rejected",
    });
    const plain = recorder(json(404, {}));
    expect(await build().send(full(), context(plain))).toMatchObject({ status: "unknown" });
    const moved = recorder(json(422, {}));
    expect(await build({ unknownStatuses: [422] }).send(full(), context(moved))).toMatchObject({
      status: "unknown",
    });
  });

  it.each([302, 404, 408, 409, 499, 500, 504])("keeps %i unknown", async (status) => {
    const rec = recorder(() => new Response(null, { status }));
    const result = await build().send(full(), context(rec));
    expect(result).toMatchObject({ status: "unknown", httpStatus: status });
    expect(rec.calls).toHaveLength(1);
  });

  it("builds meta with config.id, which the catalog does not know", () => {
    const adapter = build();
    expect(adapter.meta).toMatchObject({ id: "examplemail", name: "Example Mail", tier: 2 });
    expect(adapter.meta.credentialFields.map((field) => field.name)).toEqual(["token"]);
    expect(getProviderMeta("examplemail")).toBeUndefined();
  });
});

describe("httpProviderFromConfig: verify", () => {
  it("sends the configured request with the credential, and a 2xx is ok", async () => {
    const rec = recorder(json(200, {}));
    expect(await build().verify(context(rec))).toEqual({ ok: true });
    expect(rec.calls[0]?.url).toBe(HTTP_VERIFY_URL);
    expect(rec.calls[0]?.init.method).toBe("GET");
    expect(rec.calls[0]?.init.redirect).toBe("manual");
    expect(rec.calls[0]?.init.body).toBeUndefined();
    expect(new Headers(rec.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("maps a 401 to not_sent/auth", async () => {
    const rec = recorder(json(401, {}));
    expect(await build().verify(context(rec))).toMatchObject({
      ok: false,
      status: "not_sent",
      reason: "auth",
    });
  });

  it("is not ok for a 302, and follows no redirect", async () => {
    const rec = recorder(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    expect(await build().verify(context(rec))).toMatchObject({ ok: false, status: "unknown" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.init.redirect).toBe("manual");
  });

  it("sends POST when the config says so", async () => {
    const rec = recorder(json(200, {}));
    const verify = { endpoint: HTTP_VERIFY_URL, method: "POST" };
    await build({ verify }).verify(context(rec));
    expect(rec.calls[0]?.init.method).toBe("POST");
  });
});

describe("httpProviderFromConfig: setup checks", () => {
  it("throws without allowHosts", () => {
    refused(() => httpProviderFromConfig(config(), undefined as never));
    refused(() => httpProviderFromConfig(config(), {} as never));
    refused(() => httpProviderFromConfig(config(), { allowHosts: [] }));
    refused(() => httpProviderFromConfig(config(), { allowHosts: ["*"] }));
  });

  it.each([
    ["an http URL", "http://mail.example.test/v1/send"],
    ["127.0.0.1", "https://127.0.0.1/v1/send"],
    ["a decimal IPv4", "https://2130706433/v1/send"],
    ["a hex IPv4", "https://0x7f000001/v1/send"],
    ["an IPv6 literal", "https://[::1]/v1/send"],
    ["localhost", "https://localhost/v1/send"],
    ["localhost with a dot", "https://localhost./v1/send"],
    ["an internal name", "https://api.internal/v1/send"],
    ["userinfo", `https://user:${SECRET}@mail.example.test/v1/send`],
    ["a query string", `https://mail.example.test/v1/send?key=${SECRET}`],
    ["a fragment", "https://mail.example.test/v1/send#x"],
    ["a host outside allowHosts", "https://other.example.test/v1/send"],
    ["a port that allowHosts does not name", "https://mail.example.test:8443/v1/send"],
    ["a value that is not a string", 42],
  ])("throws for an endpoint with %s, and never echoes the URL", (_label, endpoint) => {
    const text = refused(() => build({ endpoint }), String(endpoint), "example.test");
    expect(text).toContain("config.endpoint");
  });

  it("allows a port that an allowHosts entry names", () => {
    const adapter = httpProviderFromConfig(
      config({ endpoint: "https://mail.example.test:8443/v1/send" }),
      { allowHosts: ["mail.example.test", "mail.example.test:8443"] },
    );
    expect(adapter.meta.id).toBe("examplemail");
  });

  it("throws for a verify URL outside allowHosts, and for a verify URL with a query", () => {
    const outside = refused(() => build({ verify: { endpoint: "https://other.example.test/me" } }));
    expect(outside).toContain("config.verify.endpoint");
    refused(() => build({ verify: { endpoint: `${HTTP_VERIFY_URL}?token=${SECRET}` } }));
    refused(() => build({ verify: undefined }));
    refused(() => build({ verify: { endpoint: HTTP_VERIFY_URL, method: "DELETE" } }));
    refused(() => build({ verify: { endpoint: HTTP_VERIFY_URL, token: SECRET } }));
  });

  it("throws for an unknown auth type", () => {
    refused(() => build({ auth: { type: "oauth" } }));
    refused(() => build({ auth: {} }));
    refused(() => build({ auth: "bearer" }));
  });

  it("throws for an extra key in auth, such as token, and never echoes it", () => {
    refused(() => build({ auth: { type: "bearer", token: SECRET } }));
    refused(() => build({ auth: { type: "basic", username: "api", password: SECRET } }));
    refused(() => build({ auth: { type: "header", header: "X-Key", value: SECRET } }));
    refused(() => build({ auth: { type: "bearer", [SECRET]: true } }));
  });

  it("throws for a bad basic user name or a bad auth header name", () => {
    refused(() => build({ auth: { type: "basic" } }));
    refused(() => build({ auth: { type: "basic", username: "a:b" } }));
    refused(() => build({ auth: { type: "header" } }));
    refused(() => build({ auth: { type: "header", header: "bad name" } }));
    refused(() => build({ auth: { type: "header", header: "Content-Type" } }));
  });

  it.each([
    "authorization",
    "Authorization",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "X-Server-Token",
    "cookie",
  ])("throws for a static %s header, and never echoes its value", (name) => {
    refused(() => build({ requestHeaders: { [name]: SECRET } }));
  });

  it("throws for a static header that replaces the auth header, or a bad static header", () => {
    refused(() =>
      build({ auth: { type: "header", header: "X-Mail" }, requestHeaders: { "x-mail": "1" } }),
    );
    refused(() => build({ requestHeaders: { host: "evil.example" } }));
    refused(() => build({ requestHeaders: { "X-A": "line\r\nX-B: 1" } }));
    refused(() => build({ requestHeaders: { "bad name": "1" } }));
    refused(() => build({ requestHeaders: ["x"] }));
  });

  it("throws with no attachment mapping, and for each missing required field", () => {
    for (const key of ["attachments", "from", "to", "subject"]) {
      const fields: Record<string, string> = { ...httpFixtureConfig().fields };
      delete fields[key];
      const text = refused(() => build({ fields }));
      expect(text).toContain(`config.fields.${key}`);
    }
  });

  it("throws for an unknown field, a duplicate key, and a key that is not safe", () => {
    const base = httpFixtureConfig().fields;
    refused(() => build({ fields: { ...base, template: "tpl" } }));
    refused(() => build({ fields: { ...base, html: "body", text: "body" } }));
    refused(() => build({ fields: { ...base, subject: "__proto__" } }));
    refused(() => build({ fields: { ...base, subject: "a.b" } }));
    refused(() => build({ fields: { ...base, subject: "" } }));
    refused(() => build({ attachmentFields: { filename: "x", content: "x" } }));
    refused(() => build({ attachmentFields: { url: "x" } }));
  });

  it("throws for an unknown top-level key, such as a token", () => {
    refused(() => build({ token: SECRET }));
    refused(() => build({ apiKey: SECRET }));
  });

  it("throws for a reserved id, a bad id, and a bad name", () => {
    refused(() => build({ id: "resend" }));
    refused(() => build({ id: "http" }));
    refused(() => build({ id: "Example" }));
    refused(() => build({ name: "" }));
  });

  it("throws for a bad method, address format, idFrom, and status lists", () => {
    refused(() => build({ method: "GET" }));
    refused(() => build({ addressFormat: "mime" }));
    refused(() => build({ idFrom: "data..id" }));
    for (const list of [[500], [302], [408], [409]])
      refused(() => build({ notSentStatuses: list }));
    refused(() => build({ unknownStatuses: [500] }));
  });

  it("throws for a config that is not an object", () => {
    refused(() => httpProviderFromConfig(null as never, { allowHosts: ALLOW }));
    refused(() => httpProviderFromConfig([] as never, { allowHosts: ALLOW }));
  });

  it("builds from a config that went through JSON", () => {
    const parsed = JSON.parse(JSON.stringify(httpFixtureConfig())) as HttpProviderConfig;
    expect(httpProviderFromConfig(parsed, { allowHosts: ALLOW }).meta.id).toBe("examplemail");
  });
});
