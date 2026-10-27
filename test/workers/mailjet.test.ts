import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  MAILJET_FIXTURE_SECRET,
  mailjetEvent,
  mailjetFixture,
  signMailjetWebhook,
} from "../../src/conformance/fixtures/mailjet";
import { utf8 } from "../../src/internal/encoding";
import { mailjet } from "../../src/providers/mailjet/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SECRET = MAILJET_FIXTURE_SECRET;

describe("Mailjet webhooks (workerd)", () => {
  it("checks the Basic header with Web Crypto", async () => {
    const hooks = mailjet().webhooks;
    const now = Date.now();
    const body = utf8(JSON.stringify([mailjetEvent("sent"), mailjetEvent("spam")]));
    const sample = await signMailjetWebhook({ body, secret: SECRET });
    expect(await hooks.verify({ ...sample, secret: SECRET, now })).toEqual({ ok: true });
    expect(await hooks.verify({ ...sample, secret: `${SECRET}x`, now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = mailjet();
    const body = utf8(JSON.stringify([mailjetEvent("bounce", { hard_bounce: true })]));
    const sample = await signMailjetWebhook({ body, secret: SECRET });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/mailjet", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: SECRET, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "hard" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: mailjet(), fixture: mailjetFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
