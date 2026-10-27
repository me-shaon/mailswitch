import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  HTTP_FIXTURE_ALLOW_HOSTS,
  HTTP_FIXTURE_TOKEN,
  httpFixture,
  httpFixtureConfig,
} from "../../src/conformance/fixtures/http";
import type { SendContext } from "../../src/core/adapter";
import type { FetchLike } from "../../src/internal/http";
import {
  type HttpProviderConfig,
  httpProvider,
  httpProviderFromConfig,
} from "../../src/providers/http/index";

const ALLOW = HTTP_FIXTURE_ALLOW_HOSTS;
const MESSAGE = {
  from: "billing@example.com",
  to: ["ana@example.org"],
  subject: "Hi",
  text: "Hi",
};

function recorder(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  const ctx: SendContext = {
    fetch: fetcher,
    timeoutMs: 5_000,
    credentials: { token: HTTP_FIXTURE_TOKEN },
    now: Date.now(),
  };
  return { calls, ctx };
}

const fromConfig = (overrides: Record<string, unknown> = {}) =>
  httpProviderFromConfig({ ...httpFixtureConfig(), ...overrides } as HttpProviderConfig, {
    allowHosts: ALLOW,
  });

function code(overrides: Record<string, unknown> = {}) {
  return httpProvider({
    id: "acme-mail",
    name: "Acme Mail",
    credentialFields: [{ name: "token", label: "Token", secret: true, required: true }],
    capabilities: {
      attachments: true,
      maxMessageBytes: null,
      cc: false,
      bcc: false,
      replyTo: false,
      customHeaders: false,
    },
    buildRequest: () => ({ url: "https://mail.example.test/v1/send", body: {} }),
    verifyRequest: () => ({ url: "https://mail.example.test/v1/me" }),
    allowHosts: ALLOW,
    ...overrides,
  });
}

describe("generic HTTP provider (workerd)", () => {
  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: fromConfig(), fixture: httpFixture(), tier: 2 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });

  it("R8: refuses a notSentStatuses entry of 500, 302, 408, or 409 at setup", () => {
    for (const list of [[500], [302], [408], [409]]) {
      expect(() => fromConfig({ notSentStatuses: list })).toThrow(TypeError);
      expect(() => code({ notSentStatuses: list })).toThrow(TypeError);
    }
  });

  it("R8: keeps 302, 404, 409, 499, 504, a timeout, and a thrown fetch unknown", async () => {
    for (const status of [302, 404, 409, 499, 504]) {
      const { ctx } = recorder(() => new Response(null, { status }));
      expect(await fromConfig().send(MESSAGE, ctx)).toMatchObject({ status: "unknown" });
    }
    const timeout = recorder(() => {
      throw new DOMException("Timed out.", "TimeoutError");
    });
    expect(await fromConfig().send(MESSAGE, timeout.ctx)).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
    const network = recorder(() => {
      throw new TypeError("Network connection lost.");
    });
    expect(await fromConfig().send(MESSAGE, network.ctx)).toMatchObject({
      status: "unknown",
      reason: "network",
    });
  });

  it("R8: turns a hook answer of not_sent for a 503 into unknown", async () => {
    const { ctx } = recorder(() => new Response("{}", { status: 503 }));
    const adapter = code({ classify: () => ({ status: "not_sent", reason: "rejected" }) });
    expect(await adapter.send(MESSAGE, ctx)).toMatchObject({ status: "unknown", httpStatus: 503 });
  });

  it("R9: refuses each bad endpoint at setup", () => {
    for (const endpoint of [
      "http://mail.example.test/v1/send",
      "https://127.0.0.1/v1/send",
      "https://2130706433/v1/send",
      "https://0x7f000001/v1/send",
      "https://[::1]/v1/send",
      "https://localhost/v1/send",
      "https://localhost./v1/send",
      "https://api.internal/v1/send",
      "https://user:pass@mail.example.test/v1/send",
      "https://mail.example.test/v1/send?x=1",
      "https://other.example.test/v1/send",
      "https://mail.example.test:8443/v1/send",
    ]) {
      expect(() => fromConfig({ endpoint }), endpoint).toThrow(TypeError);
    }
    expect(() => httpProviderFromConfig(httpFixtureConfig(), { allowHosts: [] })).toThrow(
      TypeError,
    );
    expect(() => httpProviderFromConfig(httpFixtureConfig(), { allowHosts: ["*"] })).toThrow(
      TypeError,
    );
    expect(() => fromConfig({ verify: { endpoint: "https://other.example.test/me" } })).toThrow(
      TypeError,
    );
  });

  it("R9: refuses a buildRequest URL on another host with no fetch", async () => {
    const { calls, ctx } = recorder(() => new Response("{}"));
    const adapter = code({ buildRequest: () => ({ url: "https://other.example/v1/send" }) });
    expect(await adapter.send(MESSAGE, ctx)).toMatchObject({
      status: "not_sent",
      reason: "unsupported",
    });
    expect(calls).toHaveLength(0);
  });

  it("R9: sends with redirect manual, and a verify 302 is not ok", async () => {
    const { calls, ctx } = recorder(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    expect(await fromConfig().verify(ctx)).toMatchObject({ ok: false, status: "unknown" });
    expect(await fromConfig().send(MESSAGE, ctx)).toMatchObject({ status: "unknown" });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
  });
});
