import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  MAILERSEND_FIXTURE_SECRET,
  mailersendEvent,
  mailersendFixture,
  signMailersendWebhook,
} from "../../src/conformance/fixtures/mailersend";
import { utf8 } from "../../src/internal/encoding";
import { mailersend } from "../../src/providers/mailersend/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SECRET = MAILERSEND_FIXTURE_SECRET;

describe("MailerSend webhooks (workerd)", () => {
  it("checks an HMAC-SHA256 signature with Web Crypto", async () => {
    const hooks = mailersend().webhooks;
    const now = Date.now();
    const body = utf8(JSON.stringify(mailersendEvent("activity.delivered")));
    const sample = await signMailersendWebhook({ body, secret: SECRET });
    expect(await hooks.verify({ ...sample, secret: SECRET, now })).toEqual({ ok: true });
    const changed = utf8(JSON.stringify(mailersendEvent("activity.hard_bounced")));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: SECRET, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = mailersend();
    const body = utf8(JSON.stringify(mailersendEvent("activity.soft_bounced")));
    const sample = await signMailersendWebhook({ body, secret: SECRET });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/mailersend", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: SECRET, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "soft" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({
      adapter: mailersend(),
      fixture: mailersendFixture(),
      tier: 1,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
