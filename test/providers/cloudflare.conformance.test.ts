import { describe, expect, it } from "vitest";
import {
  cloudflareBindingBridge,
  cloudflareBindingFixture,
  cloudflareRestFixture,
} from "../../src/conformance/fixtures/cloudflare";
import { runChecks } from "../../src/conformance/index";
import { runConformance } from "../../src/conformance/vitest";
import { cloudflareRest } from "../../src/providers/cloudflare/index";

runConformance(cloudflareRest(), cloudflareRestFixture(), { tier: 1 });
runConformance(cloudflareBindingBridge().adapter, cloudflareBindingFixture(), { tier: 1 });

describe("conformance reports of the Cloudflare adapters", () => {
  it("passes the REST transport with only the webhook and idempotency checks n/a", async () => {
    const report = await runChecks({
      adapter: cloudflareRest(),
      fixture: cloudflareRestFixture(),
      tier: 1,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    const na = report.checks.filter((entry) => entry.status === "n/a").map((entry) => entry.id);
    expect(na).toEqual([
      "send.idempotency",
      "idempotency.conflict",
      "webhook.valid",
      "webhook.changed",
      "webhook.wrong-secret",
      "webhook.stale",
      "webhook.malformed",
      "events.parse",
    ]);
  });

  it("passes the binding transport", async () => {
    const report = await runChecks({
      adapter: cloudflareBindingBridge().adapter,
      fixture: cloudflareBindingFixture(),
      tier: 1,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((entry) => entry.id === "send.ok")?.status).toBe("pass");
  });
});
