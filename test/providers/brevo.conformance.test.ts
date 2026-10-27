import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { brevoFixture } from "../../src/conformance/fixtures/brevo";
import { runConformance } from "../../src/conformance/vitest";
import { brevo } from "../../src/providers/brevo/index";

runConformance(brevo(), brevoFixture(), { tier: 1 });

describe("conformance report of the Brevo adapter", () => {
  it("passes at tier 1 with the idempotency checks active", async () => {
    const report = await runChecks({ adapter: brevo(), fixture: brevoFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checks
        .filter((entry) => entry.status === "n/a")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["send.batch", "webhook.stale"]);
  });
});
