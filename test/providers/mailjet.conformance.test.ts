import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { mailjetFixture } from "../../src/conformance/fixtures/mailjet";
import { runConformance } from "../../src/conformance/vitest";
import { mailjet } from "../../src/providers/mailjet/index";

runConformance(mailjet(), mailjetFixture(), { tier: 1 });

describe("conformance report of the Mailjet adapter", () => {
  it("passes at tier 1 with send.batch active and marks only idempotency and stale n/a", async () => {
    const report = await runChecks({ adapter: mailjet(), fixture: mailjetFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checks
        .filter((entry) => entry.status === "n/a")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["idempotency.conflict", "send.idempotency", "webhook.stale"]);
  });
});
