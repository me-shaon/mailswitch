import { describe, expect, it } from "vitest";
import { CHECK_IDS, runChecks } from "../../src/conformance/index";
import { runConformance } from "../../src/conformance/vitest";
import { fakeFixture, fakeProvider } from "../../src/testing/index";

// The fake provider in the fetch transport passes every check that applies.
runConformance(fakeProvider({ transport: "fetch" }), fakeFixture(), { tier: 1 });

describe("conformance report of the fake provider", () => {
  it("passes, runs every check, and marks only sendBatch n/a", async () => {
    const report = await runChecks({
      adapter: fakeProvider({ transport: "fetch" }),
      fixture: fakeFixture(),
      tier: 1,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.provider).toBe("fake");
    expect(report.checks.map((entry) => entry.id)).toEqual(CHECK_IDS);
    const na = report.checks.filter((entry) => entry.status === "n/a");
    expect(na).toEqual([
      expect.objectContaining({ id: "send.batch", reason: "The adapter has no sendBatch." }),
    ]);
  });

  it("fails declaration.tier when the declared tier differs from meta", async () => {
    const report = await runChecks({
      adapter: fakeProvider({ transport: "fetch" }),
      fixture: fakeFixture(),
      tier: 2,
    });
    const entry = report.checks.find((item) => item.id === "declaration.tier");
    expect(entry?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});
