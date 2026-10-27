import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  SENDGRID_FIXTURE_PUBLIC_KEY,
  sendgridEvent,
  sendgridFixture,
  signSendgridWebhook,
} from "../../src/conformance/fixtures/sendgrid";
import { utf8 } from "../../src/internal/encoding";
import { sendgrid } from "../../src/providers/sendgrid/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const KEY = SENDGRID_FIXTURE_PUBLIC_KEY;

describe("SendGrid webhooks (workerd)", () => {
  it("checks an ECDSA P-256 signature with Web Crypto", async () => {
    const hooks = sendgrid().webhooks;
    const now = Date.now();
    const body = utf8(JSON.stringify([sendgridEvent("delivered")]));
    const sample = await signSendgridWebhook({ body, secret: KEY, at: now });
    expect(await hooks.verify({ ...sample, secret: KEY, now })).toEqual({ ok: true });
    const changed = utf8(JSON.stringify([sendgridEvent("bounce", { type: "bounce" })]));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: KEY, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = sendgrid();
    const body = utf8(JSON.stringify([sendgridEvent("bounce", { type: "blocked" })]));
    const sample = await signSendgridWebhook({ body, secret: KEY, at: Date.now() });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/sendgrid", {
          method: "POST",
          headers: sample.headers,
          body: sample.body,
        }),
        { adapter, secret: KEY, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "soft" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: sendgrid(), fixture: sendgridFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
