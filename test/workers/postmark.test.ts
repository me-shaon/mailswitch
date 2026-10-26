import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  POSTMARK_FIXTURE_SECRET,
  postmarkBounce,
  postmarkFixture,
} from "../../src/conformance/fixtures/postmark";
import { bytesToBase64, utf8 } from "../../src/internal/encoding";
import { postmark, postmarkWebhookAuthorization } from "../../src/providers/postmark/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const SECRET = POSTMARK_FIXTURE_SECRET;

describe("Postmark webhooks (workerd)", () => {
  it("checks Basic auth with Web Crypto and refuses the wrong user", async () => {
    const hooks = postmark().webhooks;
    const body = utf8(postmarkBounce("ana@example.org"));
    const now = Date.now();
    const lower = `basic ${bytesToBase64(utf8(`mailswitch:${SECRET}`))}`;
    const good = new Headers({ authorization: lower });
    expect(await hooks.verify({ headers: good, body, secret: SECRET, now })).toEqual({ ok: true });
    const wrongUser = new Headers({
      authorization: `Basic ${bytesToBase64(utf8(`other:${SECRET}`))}`,
    });
    expect(await hooks.verify({ headers: wrongUser, body, secret: SECRET, now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = postmark();
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/postmark", {
          method: "POST",
          headers: { authorization: postmarkWebhookAuthorization(SECRET) },
          body: postmarkBounce("ana@example.org"),
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
    const report = await runChecks({ adapter: postmark(), fixture: postmarkFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
