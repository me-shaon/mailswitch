import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/index";
import { fakeFixture, fakeProvider } from "../../src/testing/index";

describe("conformance kit (workerd)", () => {
  it("passes the fake provider in the Workers runtime", async () => {
    const report = await runChecks({
      adapter: fakeProvider({ transport: "fetch" }),
      fixture: fakeFixture(),
      tier: 1,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("finds a leaked key in the Workers runtime", async () => {
    const base = fakeProvider({ transport: "fetch" });
    const report = await runChecks({
      adapter: {
        ...base,
        async send(message, ctx) {
          const result = await base.send(message, ctx);
          return result.status === "sent"
            ? result
            : { ...result, message: `key ${ctx.credentials.apiKey}` };
        },
      },
      fixture: fakeFixture(),
      tier: 1,
    });
    expect(report.checks.find((entry) => entry.id === "redaction")?.status).toBe("fail");
  });
});
