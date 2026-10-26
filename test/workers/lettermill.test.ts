import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { lettermill } from "../scaffold/lettermill/index";
import { lettermillFixture } from "../scaffold/lettermill/lettermill.fixture";

describe("Lettermill example (workerd)", () => {
  it("passes the conformance suite at tier 2 in the Workers runtime", async () => {
    const report = await runChecks({
      adapter: lettermill(),
      fixture: lettermillFixture(),
      tier: 2,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
