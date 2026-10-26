import { describe, expect, it } from "vitest";
import { type CheckReport, type ConformanceFixture, runChecks } from "../../src/conformance/index";
import type { ProviderAdapter } from "../../src/index";
import { FAKE_API_BASE, fakeFixture, fakeMeta, fakeProvider } from "../../src/testing/index";

// The kit tests itself: each broken adapter must fail the check that targets its fault.

function entry(report: CheckReport, id: CheckReport["checks"][number]["id"]) {
  return report.checks.find((item) => item.id === id);
}

function failed(report: CheckReport): string[] {
  return report.checks.filter((item) => item.status === "fail").map((item) => item.id);
}

function problems(report: CheckReport, id: CheckReport["checks"][number]["id"]): string {
  const item = entry(report, id);
  return item?.status === "fail" ? item.problems.join("\n") : "";
}

describe("conformance kit on broken adapters", () => {
  it("fails redaction for an adapter that echoes the API key in an error (AE6)", async () => {
    const base = fakeProvider({ transport: "fetch" });
    const leaky: ProviderAdapter = {
      ...base,
      async send(message, ctx) {
        const result = await base.send(message, ctx);
        if (result.status === "sent") return result;
        return { ...result, message: `${result.message} Key: ${ctx.credentials.apiKey}` };
      },
    };
    const report = await runChecks({ adapter: leaky, fixture: fakeFixture(), tier: 1 });
    expect(failed(report)).toEqual(["redaction"]);
    expect(problems(report, "redaction")).toContain("raw apiKey");
  });

  it("fails redaction for a base64 Basic credential in a thrown error", async () => {
    const base = fakeProvider({ transport: "fetch" });
    const leaky: ProviderAdapter = {
      ...base,
      async verify(ctx) {
        const result = await base.verify(ctx);
        if (result.ok) return result;
        throw new Error(`Login failed for ${btoa(`api:${ctx.credentials.apiKey}`)}`);
      },
    };
    const report = await runChecks({ adapter: leaky, fixture: fakeFixture(), tier: 1 });
    expect(failed(report)).toContain("redaction");
    expect(problems(report, "redaction")).toContain("Basic api:apiKey");
  });

  it("fails redaction for an adapter that logs the request headers", async () => {
    const base = fakeProvider({ transport: "fetch" });
    const noisy: ProviderAdapter = {
      ...base,
      async send(message, ctx) {
        console.warn("sending", { auth: `Bearer ${ctx.credentials.apiKey}` });
        return base.send(message, ctx);
      },
    };
    const report = await runChecks({ adapter: noisy, fixture: fakeFixture(), tier: 1 });
    expect(problems(report, "redaction")).toContain("console.warn");
  });

  it("fails declaration.tier for a tier 2 adapter that maps 503 to not_sent (AE5)", async () => {
    const base = fakeProvider({ transport: "fetch" });
    // A raw meta object: defineProviderMeta would throw for this map.
    const meta = { ...fakeMeta(), tier: 2 as const };
    const overconfident: ProviderAdapter = {
      ...base,
      meta,
      async send(message, ctx) {
        const result = await base.send(message, ctx);
        if (result.status === "unknown" && result.httpStatus === 503) {
          return { ...result, status: "not_sent" };
        }
        return result;
      },
    };
    const report = await runChecks({ adapter: overconfident, fixture: fakeFixture(), tier: 2 });
    expect(failed(report)).toEqual(["declaration.tier"]);
    expect(problems(report, "declaration.tier")).toContain(
      "A tier 2 provider must return unknown for HTTP 503, not not_sent.",
    );
  });

  it("fails capability.refuse for an adapter that calls fetch for an unsupported message", async () => {
    const base = fakeProvider({ transport: "fetch" });
    const eager: ProviderAdapter = {
      ...base,
      async send(message, ctx) {
        // It sends before the capability check, so the request already went out.
        await ctx.fetch(`${FAKE_API_BASE}/emails`, { method: "POST", body: "{}" });
        return base.send(message, ctx);
      },
    };
    const report = await runChecks({ adapter: eager, fixture: fakeFixture(), tier: 1 });
    expect(entry(report, "capability.refuse")?.status).toBe("fail");
    expect(problems(report, "capability.refuse")).toContain("Refuse it before any network call.");
  });

  it("fails idempotency.conflict for an adapter that maps the key conflict to not_sent", async () => {
    const base = fakeProvider({ transport: "fetch" });
    const careless: ProviderAdapter = {
      ...base,
      async send(message, ctx) {
        const result = await base.send(message, ctx);
        return result.status === "unknown" && result.httpStatus === 409
          ? { ...result, status: "not_sent" }
          : result;
      },
    };
    const report = await runChecks({ adapter: careless, fixture: fakeFixture(), tier: 1 });
    expect(failed(report)).toEqual(["idempotency.conflict"]);
  });

  it("fails webhook checks for an adapter that accepts any webhook", async () => {
    const base = fakeProvider({ transport: "fetch" });
    const open: ProviderAdapter = {
      ...base,
      webhooks: { verify: async () => ({ ok: true }), parse: base.webhooks?.parse ?? (() => []) },
    };
    const report = await runChecks({ adapter: open, fixture: fakeFixture(), tier: 1 });
    expect(failed(report)).toEqual([
      "webhook.changed",
      "webhook.wrong-secret",
      "webhook.stale",
      "webhook.malformed",
    ]);
  });

  it("fails a missing fixture part instead of skipping it", async () => {
    const fixture: ConformanceFixture = { ...fakeFixture() };
    delete fixture.webhook;
    delete fixture.readAttachments;
    const report = await runChecks({
      adapter: fakeProvider({ transport: "fetch" }),
      fixture,
      tier: 1,
    });
    expect(failed(report)).toEqual([
      "attachments",
      "webhook.valid",
      "webhook.changed",
      "webhook.wrong-secret",
      "webhook.stale",
      "webhook.malformed",
      "events.parse",
    ]);
    expect(problems(report, "webhook.valid")).toContain("Add fixture.webhook.");
    expect(problems(report, "attachments")).toContain("Add fixture.readAttachments.");
  });

  it("fails declaration.tier for meta.webhooks without webhooks methods", async () => {
    const { webhooks: _dropped, ...rest } = fakeProvider({ transport: "fetch" });
    const report = await runChecks({ adapter: rest, fixture: fakeFixture(), tier: 1 });
    expect(problems(report, "declaration.tier")).toContain("no webhooks methods");
  });
});
