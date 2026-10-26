import { describe, expect, it } from "vitest";
import {
  RESEND_FIXTURE_SECRET,
  resendEvent,
  resendFixture,
  signResendWebhook,
} from "../../src/conformance/fixtures/resend";
import { runChecks } from "../../src/conformance/index";
import { utf8 } from "../../src/provider-kit/index";
import { resend } from "../../src/providers/resend/index";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");

describe("resend (workerd)", () => {
  it("verifies a Svix signature and refuses a changed body", async () => {
    const hooks = resend().webhooks;
    const body = utf8(resendEvent("email.bounced", { bounce: { type: "Permanent" } }));
    const sample = await signResendWebhook({ body, secret: RESEND_FIXTURE_SECRET, at: NOW });
    const input = { headers: sample.headers, body, secret: RESEND_FIXTURE_SECRET, now: NOW };
    expect(await hooks?.verify(input)).toEqual({ ok: true });
    const changed = body.slice();
    changed[changed.length - 2] = 0x20;
    expect(await hooks?.verify({ ...input, body: changed })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: resend(), fixture: resendFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
