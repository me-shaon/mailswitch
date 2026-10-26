// mailswitch/conformance/vitest: the conformance kit as a Vitest suite. vitest is an
// optional peer dependency, and only this file imports it. Call it from a test file next
// to the adapter:
//
//   runConformance(myAdapter, myFixture, { tier: 1 });
//
// A check that does not apply shows as skipped, with the reason in its name.

import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "../core/adapter";
import { conformanceChecks } from "./checks";
import type { ConformanceFixture, RunChecksOptions } from "./types";

/** Registers one describe block with one test per check. */
export function runConformance(
  adapter: ProviderAdapter,
  fixture: ConformanceFixture,
  options: RunChecksOptions,
): void {
  const name = typeof adapter.meta?.name === "string" ? adapter.meta.name : "adapter";
  describe(`${name} conformance (tier ${options.tier})`, () => {
    for (const check of conformanceChecks(adapter, fixture, options)) {
      if (check.notApplicable !== undefined) {
        it.skip(`${check.id}: ${check.title} [n/a: ${check.notApplicable}]`, () => {});
        continue;
      }
      it(`${check.id}: ${check.title}`, async () => {
        const result = await check.run();
        if (result.status === "fail") expect.fail(result.problems.join("\n"));
        expect(result.status).toBe("pass");
      });
    }
  });
}
