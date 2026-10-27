import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  MAILTRAP_FIXTURE_SECRET,
  mailtrapEvent,
  mailtrapEvents,
  mailtrapFixture,
  signMailtrapWebhook,
} from "../../src/conformance/fixtures/mailtrap";
import { utf8 } from "../../src/internal/encoding";
import { mailtrap } from "../../src/providers/mailtrap/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SECRET = MAILTRAP_FIXTURE_SECRET;

describe("Mailtrap (workerd)", () => {
  it("checks a hex HMAC-SHA256 signature with Web Crypto", async () => {
    const hooks = mailtrap().webhooks;
    const now = Date.now();
    const body = utf8(mailtrapEvents(mailtrapEvent("delivery")));
    const sample = await signMailtrapWebhook({ body, secret: SECRET });
    expect(await hooks.verify({ ...sample, secret: SECRET, now })).toEqual({ ok: true });
    const changed = utf8(mailtrapEvents(mailtrapEvent("bounce")));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: SECRET, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = mailtrap();
    const body = utf8(mailtrapEvents(mailtrapEvent("delivery"), mailtrapEvent("spam")));
    const sample = await signMailtrapWebhook({ body, secret: SECRET });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/mailtrap", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: SECRET, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "delivered" }, { type: "complained" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: mailtrap(), fixture: mailtrapFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
