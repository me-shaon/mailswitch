import { describe, expect, it } from "vitest";
import { resendFixture } from "../../src/conformance/fixtures/resend";
import { runChecks } from "../../src/conformance/index";
import { runConformance } from "../../src/conformance/vitest";
import { resend } from "../../src/providers/resend/index";

runConformance(resend(), resendFixture(), { tier: 1 });

describe("conformance report of the Resend adapter", () => {
  it("passes every check, with none n/a", async () => {
    const report = await runChecks({ adapter: resend(), fixture: resendFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status !== "pass")).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
