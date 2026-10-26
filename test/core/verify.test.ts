import { describe, expect, it } from "vitest";
import { mockFetch } from "../../src/conformance/index";
import { resend } from "../../src/providers/resend/index";

describe("verify", () => {
  it("returns not_sent/auth for a wrong Resend key and sends no email", async () => {
    const mock = mockFetch([
      {
        label: "wrong key",
        method: "GET",
        url: "https://api.resend.com/domains",
        response: {
          status: 401,
          body: { name: "validation_error", message: "API key is invalid" },
        },
      },
    ]);
    const result = await resend().verify({
      fetch: mock.fetch,
      timeoutMs: 1000,
      credentials: { apiKey: "re_wrong_key_123" },
      now: Date.parse("2026-10-26T12:00:00.000Z"),
    });
    expect(result).toMatchObject({ ok: false, status: "not_sent", reason: "auth" });
    expect(JSON.stringify(result)).not.toContain("re_wrong_key_123");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls.some((call) => call.url.includes("/emails"))).toBe(false);
    expect(mock.unmatched).toEqual([]);
  });
});
