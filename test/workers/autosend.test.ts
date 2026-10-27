import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  AUTOSEND_FIXTURE_SECRET,
  autosendEvent,
  autosendFixture,
  signAutosendWebhook,
} from "../../src/conformance/fixtures/autosend";
import { utf8 } from "../../src/internal/encoding";
import { autosend } from "../../src/providers/autosend/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SECRET = AUTOSEND_FIXTURE_SECRET;

describe("AutoSend (workerd)", () => {
  it("checks a hex HMAC-SHA256 signature with Web Crypto", async () => {
    const hooks = autosend().webhooks;
    const now = Date.now();
    const sample = await signAutosendWebhook({
      body: utf8(autosendEvent("email.delivered")),
      secret: SECRET,
    });
    expect(await hooks.verify({ ...sample, secret: SECRET, now })).toEqual({ ok: true });
    const changed = utf8(autosendEvent("email.bounced"));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: SECRET, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("drops a replay with a new delivery id through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = autosend();
    const sample = await signAutosendWebhook({
      body: utf8(autosendEvent("email.bounced", { bounceType: "Transient" })),
      secret: SECRET,
    });
    const send = (deliveryId: string) => {
      const headers = new Headers(sample.headers);
      headers.set("x-webhook-delivery-id", deliveryId);
      return handleWebhook(
        new Request("https://app.example.com/hooks/autosend", {
          method: "POST",
          headers,
          body: sample.body,
        }),
        { adapter, secret: SECRET, dedupe },
      );
    };
    const first = await send("delivery-1");
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "soft" }]);
    await first.ack();
    expect(await send("delivery-2")).toMatchObject({ ok: true, events: [] });
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: autosend(), fixture: autosendFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
