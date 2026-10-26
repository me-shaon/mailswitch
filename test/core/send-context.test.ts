import { afterEach, describe, expect, it, vi } from "vitest";
import type { SocketConnect } from "../../src/core/socket";
import { createSendContext, sendTestEmail } from "../../src/index";
import { fakeProvider } from "../../src/testing/index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSendContext", () => {
  it("fills the defaults: global fetch, 15 seconds, and the current time", async () => {
    const global = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", global);
    const before = Date.now();
    const ctx = createSendContext({ credentials: { apiKey: "re_test" } });
    expect(ctx.timeoutMs).toBe(15_000);
    expect(ctx.credentials).toEqual({ apiKey: "re_test" });
    expect(ctx.now).toBeGreaterThanOrEqual(before);
    expect(ctx.now).toBeLessThanOrEqual(Date.now());
    expect("connect" in ctx).toBe(false);
    const response = await ctx.fetch("https://example.com/", { method: "GET" });
    expect(await response.text()).toBe("ok");
    expect(global).toHaveBeenCalledWith("https://example.com/", { method: "GET" });
  });

  it("keeps the given fetch, timeout, socket, and time", () => {
    const doFetch = async () => new Response(null, { status: 204 });
    const connect: SocketConnect = () => {
      throw new Error("not called");
    };
    const ctx = createSendContext({
      credentials: {},
      fetch: doFetch,
      timeoutMs: 2_000,
      connect,
      now: 1_700_000_000_000,
    });
    expect(ctx).toEqual({
      fetch: doFetch,
      timeoutMs: 2_000,
      credentials: {},
      connect,
      now: 1_700_000_000_000,
    });
  });

  it("throws a RangeError for a timeout that is not a positive number", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createSendContext({ credentials: {}, timeoutMs })).toThrow(RangeError);
    }
  });

  it("gives a context that verify and sendTestEmail accept", async () => {
    const fake = fakeProvider();
    const ctx = createSendContext({ credentials: {}, fetch: async () => new Response(null) });
    expect(await fake.verify(ctx)).toEqual({ ok: true });
    const result = await sendTestEmail(fake, ctx, {
      from: "hello@example.com",
      to: "ana@example.org",
    });
    expect(result.status).toBe("sent");
  });
});
