import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { zeptomailFixture } from "../../src/conformance/fixtures/zeptomail";
import { runConformance } from "../../src/conformance/vitest";
import { zeptomail } from "../../src/providers/zeptomail/index";

runConformance(zeptomail(), zeptomailFixture(), { tier: 2 });

describe("conformance report of the ZeptoMail adapter", () => {
  it("passes at tier 2 and marks only batch, idempotency, and webhooks n/a", async () => {
    const report = await runChecks({ adapter: zeptomail(), fixture: zeptomailFixture(), tier: 2 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checks
        .filter((entry) => entry.status === "n/a")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([
      "events.parse",
      "idempotency.conflict",
      "send.batch",
      "send.idempotency",
      "webhook.changed",
      "webhook.malformed",
      "webhook.stale",
      "webhook.valid",
      "webhook.wrong-secret",
    ]);
  });
});
