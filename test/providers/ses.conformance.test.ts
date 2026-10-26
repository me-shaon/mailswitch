import { sesFixture } from "../../src/conformance/fixtures/ses";
import { runConformance } from "../../src/conformance/vitest";
import { ses } from "../../src/providers/ses/index";

// The declared tier matches sesMeta.tier.
runConformance(ses(), sesFixture(), { tier: 1 });
