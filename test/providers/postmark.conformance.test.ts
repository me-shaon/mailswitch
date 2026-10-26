import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { postmarkFixture } from "../../src/conformance/fixtures/postmark";
import { runConformance } from "../../src/conformance/vitest";
import { postmark } from "../../src/providers/postmark/index";

runConformance(postmark(), postmarkFixture(), { tier: 1 });

describe("conformance report of the Postmark adapter", () => {
  it("passes at tier 1 and marks only the idempotency and stale checks n/a", async () => {
    const report = await runChecks({ adapter: postmark(), fixture: postmarkFixture(), tier: 1 });
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
