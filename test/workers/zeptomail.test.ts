import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  ZEPTOMAIL_FIXTURE_TOKEN,
  ZEPTOMAIL_NO_RECIPIENT,
  zeptomailAnswer,
  zeptomailFixture,
} from "../../src/conformance/fixtures/zeptomail";
import { mockFetch } from "../../src/conformance/mock-fetch";
import { ZEPTOMAIL_HOSTS, zeptomail } from "../../src/providers/zeptomail/index";

const URL_EU = `${ZEPTOMAIL_HOSTS.eu}/v1.1/email`;

describe("ZeptoMail adapter (workerd)", () => {
  it("sends and verifies on the region host", async () => {
    const mock = mockFetch([
      { label: "send", method: "POST", url: URL_EU, response: zeptomailAnswer(), times: 1 },
      { label: "verify", method: "POST", url: URL_EU, response: ZEPTOMAIL_NO_RECIPIENT },
    ]);
    const ctx = {
      fetch: mock.fetch,
      timeoutMs: 5_000,
      credentials: { token: `Zoho-enczapikey ${ZEPTOMAIL_FIXTURE_TOKEN}`, region: "eu" },
      now: Date.now(),
    };
    const adapter = zeptomail();
    const result = await adapter.send(
      { from: "billing@example.com", to: ["ana@example.org"], subject: "Hi", text: "Hi" },
      ctx,
    );
    expect(result.status).toBe("sent");
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    expect(mock.calls.map((call) => call.headers.get("authorization"))).toEqual([
      `Zoho-enczapikey ${ZEPTOMAIL_FIXTURE_TOKEN}`,
      `Zoho-enczapikey ${ZEPTOMAIL_FIXTURE_TOKEN}`,
    ]);
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: zeptomail(), fixture: zeptomailFixture(), tier: 2 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
