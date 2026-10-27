import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { mailchannelsFixture } from "../../src/conformance/fixtures/mailchannels";
import { runConformance } from "../../src/conformance/vitest";
import { mailchannels } from "../../src/providers/mailchannels/index";

runConformance(mailchannels(), mailchannelsFixture(), { tier: 1 });

describe("conformance report of the MailChannels adapter", () => {
  it("passes at tier 1 and marks only the idempotency and batch checks n/a", async () => {
    const report = await runChecks({
      adapter: mailchannels(),
      fixture: mailchannelsFixture(),
      tier: 1,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checks
        .filter((entry) => entry.status === "n/a")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["idempotency.conflict", "send.batch", "send.idempotency"]);
  });
});
