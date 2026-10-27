import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { ahasendFixture } from "../../src/conformance/fixtures/ahasend";
import { runConformance } from "../../src/conformance/vitest";
import { ahasend } from "../../src/providers/ahasend/index";

runConformance(ahasend(), ahasendFixture(), { tier: 1 });

describe("conformance report of the AhaSend adapter", () => {
  it("passes at tier 1 with the idempotency checks active and only the batch check n/a", async () => {
    const report = await runChecks({ adapter: ahasend(), fixture: ahasendFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checks
        .filter((entry) => entry.status === "n/a")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["send.batch"]);
  });
});
