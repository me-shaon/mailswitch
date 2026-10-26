import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  MAILGUN_FIXTURE_SECRET,
  mailgunEvent,
  mailgunFixture,
  signMailgunWebhook,
} from "../../src/conformance/fixtures/mailgun";
import { utf8 } from "../../src/internal/encoding";
import { mailgun } from "../../src/providers/mailgun/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

const BOUNCE = mailgunEvent("failed", { severity: "permanent", reason: "bounce" });
const TOKEN = "b".repeat(50);

async function request(data: string, now: number): Promise<Request> {
  const sample = await signMailgunWebhook({
    body: utf8(data),
    secret: MAILGUN_FIXTURE_SECRET,
    at: now,
    token: TOKEN,
  });
  return new Request("https://app.test/hooks", {
    method: "POST",
    headers: sample.headers,
    body: sample.body,
  });
}

describe("Mailgun adapter (workerd)", () => {
  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: mailgun(), fixture: mailgunFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("verifies the HMAC and refuses a reused token with a different body", async () => {
    const now = Date.now();
    const options = {
      adapter: mailgun(),
      secret: MAILGUN_FIXTURE_SECRET,
      dedupe: new MemoryDedupeStore(),
      now: () => now,
    };
    const first = await handleWebhook(await request(BOUNCE, now), options);
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "hard", eventKey: TOKEN }]);
    await first.ack();
    const changed = await handleWebhook(await request(mailgunEvent("delivered"), now), options);
    expect(changed).toMatchObject({ ok: false, rejection: "bad_signature" });
  });
});
