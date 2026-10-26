import { describe, expect, it } from "vitest";
import {
  SES_FIXTURE_CERT_URL,
  SES_FIXTURE_TOPIC,
  sesFixture,
  sesFixtureSigner,
  sesNotification,
  signSesWebhook,
} from "../../src/conformance/fixtures/ses";
import { runChecks } from "../../src/conformance/index";
import { utf8 } from "../../src/provider-kit/index";
import { ses } from "../../src/providers/ses/index";

const NOW = Date.parse("2026-10-26T12:00:30.000Z");

describe("ses (workerd)", () => {
  it("verifies an SNS signature and refuses an untrusted topic", async () => {
    const signer = await sesFixtureSigner();
    const urls: string[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      urls.push(url);
      // Workers accept only "follow" and "manual". The verifier must not follow.
      expect(init.redirect).toBe("manual");
      new Request(url, init);
      return new Response(signer.certificatePem, { status: 200 });
    };
    const hooks = ses().webhooks;
    const body = utf8(sesNotification({ eventType: "Delivery" }));
    const sample = await signSesWebhook({ body, secret: SES_FIXTURE_TOPIC, at: NOW });
    const input = { headers: sample.headers, body: sample.body, now: NOW, fetch };
    expect(await hooks?.verify({ ...input, secret: SES_FIXTURE_TOPIC })).toEqual({ ok: true });
    expect(
      await hooks?.verify({ ...input, secret: "arn:aws:sns:us-east-1:111111111111:other" }),
    ).toEqual({ ok: false, reason: "untrusted_topic" });
    expect(urls).toEqual([SES_FIXTURE_CERT_URL]);
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: ses(), fixture: sesFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
