import { mailgunFixture } from "../../src/conformance/fixtures/mailgun";
import { runConformance } from "../../src/conformance/vitest";
import { mailgun } from "../../src/providers/mailgun/index";

runConformance(mailgun(), mailgunFixture(), { tier: 1 });
