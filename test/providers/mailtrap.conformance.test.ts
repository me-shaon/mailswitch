import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { mailtrapFixture } from "../../src/conformance/fixtures/mailtrap";
import { runConformance } from "../../src/conformance/vitest";
import { mailtrap } from "../../src/providers/mailtrap/index";

runConformance(mailtrap(), mailtrapFixture(), { tier: 1 });

describe("conformance report of the Mailtrap adapter", () => {
  it("passes at tier 1 with only the checks that do not apply n/a", async () => {
    const report = await runChecks({ adapter: mailtrap(), fixture: mailtrapFixture(), tier: 1 });
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
