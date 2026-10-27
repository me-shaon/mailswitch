import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  SMTP2GO_FIXTURE_SECRET,
  signSmtp2goWebhook,
  smtp2goEvent,
  smtp2goFixture,
} from "../../src/conformance/fixtures/smtp2go";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import { smtp2go } from "../../src/providers/smtp2go/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SECRET = SMTP2GO_FIXTURE_SECRET;

describe("SMTP2GO webhooks (workerd)", () => {
  it("checks the Bearer and Basic headers with Web Crypto", async () => {
    const hooks = smtp2go().webhooks;
    const now = Date.now();
    const body = utf8(JSON.stringify(smtp2goEvent("delivered")));
    const sample = await signSmtp2goWebhook({ body, secret: SECRET });
    expect(await hooks.verify({ ...sample, secret: SECRET, now })).toEqual({ ok: true });
    const basic = new Headers({
      authorization: `Basic ${bytesToBase64(utf8(`mailswitch:${SECRET}`))}`,
    });
    expect(await hooks.verify({ headers: basic, body, secret: SECRET, now })).toEqual({ ok: true });
    expect(await hooks.verify({ ...sample, secret: `${SECRET}x`, now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = smtp2go();
    const body = utf8(JSON.stringify(smtp2goEvent("bounce", { bounce: "hard" })));
    const sample = await signSmtp2goWebhook({ body, secret: SECRET });
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/smtp2go", {
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
    const report = await runChecks({ adapter: smtp2go(), fixture: smtp2goFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
