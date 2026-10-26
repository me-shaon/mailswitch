import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { toSendFixture } from "../../src/conformance/fixtures/tosend";
import { runConformance } from "../../src/conformance/vitest";
import { tosend } from "../../src/providers/tosend/index";

runConformance(tosend(), toSendFixture(), { tier: 1 });

describe("conformance report of the toSend adapter", () => {
  it("passes at tier 1 and marks only the stale check n/a", async () => {
    const report = await runChecks({ adapter: tosend(), fixture: toSendFixture(), tier: 1 });
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
