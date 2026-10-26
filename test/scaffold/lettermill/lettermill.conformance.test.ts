import { describe, expect, it } from "vitest";
import { runChecks } from "../../../src/conformance/index";
import { runConformance } from "../../../src/conformance/vitest";
import { lettermill } from "./index";
import { lettermillFixture } from "./lettermill.fixture";

// The worked example of docs/guides/add-a-provider.md: the scaffold output, filled in.
runConformance(lettermill(), lettermillFixture(), { tier: 2 });

describe("conformance report of the Lettermill example", () => {
  it("passes at tier 2", async () => {
    const report = await runChecks({
      adapter: lettermill(),
      fixture: lettermillFixture(),
      tier: 2,
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

  it("refuses a webhook signed in the future, outside the window", async () => {
    const fixture = lettermillFixture();
    const webhook = fixture.webhook;
    const hooks = lettermill().webhooks;
    if (!webhook || !hooks) throw new Error("Lettermill declares webhooks.");
    const now = fixture.now ?? 0;
    const sample = await webhook.sign({
      body: new TextEncoder().encode(String(webhook.samples[0]?.body)),
      secret: webhook.secret,
      at: now + 10 * 60 * 1000,
    });
    const result = await hooks.verify({ ...sample, secret: webhook.secret, now });
    expect(result).toEqual({ ok: false, reason: "stale" });
  });

  it("refines a suppressed recipient to rejected, with no body text", async () => {
    const adapter = lettermill();
    const result = await adapter.send(
      { from: "a@example.com", to: ["b@example.org"], subject: "Hi", text: "Hi" },
      {
        fetch: async () =>
          Response.json(
            { error: { code: "suppressed", message: "b@example.org is suppressed." } },
            { status: 422 },
          ),
        timeoutMs: 1000,
        credentials: { apiKey: "lm_live_test0key0123" },
        now: 0,
      },
    );
    expect(result).toMatchObject({
      status: "not_sent",
      reason: "rejected",
      provider: "lettermill",
    });
    expect(JSON.stringify(result)).not.toContain("b@example.org");
  });
});
