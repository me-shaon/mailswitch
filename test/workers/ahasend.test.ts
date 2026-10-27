import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  AHASEND_FIXTURE_SECRET,
  ahasendEvent,
  ahasendFixture,
  signAhasendWebhook,
} from "../../src/conformance/fixtures/ahasend";
import { utf8 } from "../../src/internal/encoding";
import { ahasend, ahasendIdempotencyKey } from "../../src/providers/ahasend/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SECRET = AHASEND_FIXTURE_SECRET;

describe("AhaSend (workerd)", () => {
  it("checks a Standard Webhooks signature with Web Crypto", async () => {
    const hooks = ahasend().webhooks;
    const now = Date.now();
    const body = utf8(ahasendEvent("message.delivered"));
    const sample = await signAhasendWebhook({ body, secret: SECRET, at: now });
    expect(await hooks.verify({ ...sample, secret: SECRET, now })).toEqual({ ok: true });
    const changed = utf8(ahasendEvent("message.bounced"));
    expect(
      await hooks.verify({ headers: sample.headers, body: changed, secret: SECRET, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("hashes a long idempotency key with Web Crypto", async () => {
    expect(await ahasendIdempotencyKey("k".repeat(300))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = ahasend();
    const body = utf8(ahasendEvent("message.transient_error"));
    const sample = await signAhasendWebhook({ body, secret: SECRET, at: Date.now() });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/ahasend", {
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
    const report = await runChecks({ adapter: ahasend(), fixture: ahasendFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
