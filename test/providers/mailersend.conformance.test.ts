import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { mailersendFixture } from "../../src/conformance/fixtures/mailersend";
import { runConformance } from "../../src/conformance/vitest";
import { mailersend } from "../../src/providers/mailersend/index";

runConformance(mailersend(), mailersendFixture(), { tier: 1 });

describe("conformance report of the MailerSend adapter", () => {
  it("passes at tier 1 and marks only the idempotency, batch, and stale checks n/a", async () => {
    const report = await runChecks({
      adapter: mailersend(),
      fixture: mailersendFixture(),
      tier: 1,
    });
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
