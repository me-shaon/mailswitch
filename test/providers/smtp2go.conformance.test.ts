import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { smtp2goFixture } from "../../src/conformance/fixtures/smtp2go";
import { runConformance } from "../../src/conformance/vitest";
import { smtp2go } from "../../src/providers/smtp2go/index";

runConformance(smtp2go(), smtp2goFixture(), { tier: 1 });

describe("conformance report of the SMTP2GO adapter", () => {
  it("passes at tier 1 and marks only batch, idempotency, and stale n/a", async () => {
    const report = await runChecks({ adapter: smtp2go(), fixture: smtp2goFixture(), tier: 1 });
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
