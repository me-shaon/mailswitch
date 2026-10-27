import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  HTTP_FIXTURE_ALLOW_HOSTS,
  httpFixture,
  httpFixtureConfig,
} from "../../src/conformance/fixtures/http";
import { runConformance } from "../../src/conformance/vitest";
import type { FetchLike } from "../../src/internal/http";
import { httpProviderFromConfig } from "../../src/providers/http/index";

const adapter = () =>
  httpProviderFromConfig(httpFixtureConfig(), { allowHosts: HTTP_FIXTURE_ALLOW_HOSTS });

runConformance(adapter(), httpFixture(), { tier: 2 });

describe("conformance report of the generic HTTP provider", () => {
  it("passes at tier 2 and marks only batch, idempotency, refusal, and webhooks n/a", async () => {
    const report = await runChecks({ adapter: adapter(), fixture: httpFixture(), tier: 2 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      report.checks
        .filter((entry) => entry.status === "n/a")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([
      "capability.refuse",
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
    const passed = report.checks
      .filter((entry) => entry.status === "pass")
      .map((entry) => entry.id);
    expect(passed).toEqual(
      expect.arrayContaining(["redaction", "attachments", "send.headers", "verify.ok"]),
    );
  });

  it("sends every request of the suite with redirect manual", async () => {
    const inits: RequestInit[] = [];
    const wrapped = adapter();
    const record =
      (fetcher: FetchLike): FetchLike =>
      async (input, init) => {
        inits.push(init);
        return fetcher(input, init);
      };
    const spy = {
      ...wrapped,
      send: (
        message: Parameters<typeof wrapped.send>[0],
        ctx: Parameters<typeof wrapped.send>[1],
      ) => wrapped.send(message, { ...ctx, fetch: record(ctx.fetch) }),
      verify: (ctx: Parameters<typeof wrapped.verify>[0]) =>
        wrapped.verify({ ...ctx, fetch: record(ctx.fetch) }),
    };
    const report = await runChecks({ adapter: spy, fixture: httpFixture(), tier: 2 });
    expect(report.ok).toBe(true);
    expect(inits.length).toBeGreaterThan(20);
    expect(inits.every((init) => init.redirect === "manual")).toBe(true);
  });
});
