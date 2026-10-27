import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { autosendFixture } from "../../src/conformance/fixtures/autosend";
import { runConformance } from "../../src/conformance/vitest";
import { autosend } from "../../src/providers/autosend/index";

runConformance(autosend(), autosendFixture(), { tier: 1 });

describe("conformance report of the AutoSend adapter", () => {
  it("passes at tier 1 with only the checks that do not apply n/a", async () => {
    const report = await runChecks({ adapter: autosend(), fixture: autosendFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checks
        .filter((entry) => entry.status === "n/a")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["idempotency.conflict", "send.batch", "send.idempotency", "webhook.stale"]);
  });
});
