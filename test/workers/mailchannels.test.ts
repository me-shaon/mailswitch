import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  MAILCHANNELS_FIXTURE_PUBLIC_KEY,
  mailchannelsEvent,
  mailchannelsFixture,
  signMailchannelsWebhook,
} from "../../src/conformance/fixtures/mailchannels";
import { utf8 } from "../../src/internal/encoding";
import { mailchannels } from "../../src/providers/mailchannels/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const KEY = MAILCHANNELS_FIXTURE_PUBLIC_KEY;

describe("MailChannels webhooks (workerd)", () => {
  it("checks an Ed25519 signature and the content digest with Web Crypto", async () => {
    const hooks = mailchannels().webhooks;
    const now = Date.now();
    const body = utf8(JSON.stringify([mailchannelsEvent("delivered")]));
    const sample = await signMailchannelsWebhook({ body, secret: KEY, at: now });
    expect(await hooks.verify({ ...sample, secret: KEY, now })).toEqual({ ok: true });
    const changed = utf8(JSON.stringify([mailchannelsEvent("hard-bounced")]));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: KEY, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = mailchannels();
    const body = utf8(JSON.stringify([mailchannelsEvent("soft-bounced")]));
    const sample = await signMailchannelsWebhook({ body, secret: KEY, at: Date.now() });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/mailchannels", {
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
    const report = await runChecks({
      adapter: mailchannels(),
      fixture: mailchannelsFixture(),
      tier: 1,
    });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
