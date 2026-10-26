import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { BREVO_FIXTURE_TOKEN, brevoEvent, smtpFixture } from "../../src/conformance/fixtures/smtp";
import { mockSmtp } from "../../src/conformance/mock-smtp";
import { utf8 } from "../../src/internal/encoding";
import { brevoWebhooks } from "../../src/providers/smtp/brevo-webhooks";
import { smtp } from "../../src/providers/smtp/index";

describe("SMTP adapter (workerd)", () => {
  it("imports cleanly and sends through an injected connect", async () => {
    const mock = mockSmtp({ username: "user", password: "secret" });
    const result = await smtp().send(
      { from: "a@example.com", to: ["b@example.org"], subject: "Hi", text: "Hello" },
      {
        fetch: async () => {
          throw new TypeError("no HTTP");
        },
        timeoutMs: 1000,
        credentials: { host: "smtp.example.com", username: "user", password: "secret" },
        now: Date.now(),
        connect: mock.connect,
      },
    );
    expect(result).toMatchObject({ status: "sent", provider: "smtp" });
    expect(mock.messages).toHaveLength(1);
  });

  it("checks a Brevo bearer token with Web Crypto", async () => {
    const hooks = smtp({ webhooks: brevoWebhooks() }).webhooks;
    const body = utf8(JSON.stringify(brevoEvent("spam", "ana@example.org")));
    const headers = new Headers({ authorization: `Bearer ${BREVO_FIXTURE_TOKEN}` });
    expect(
      await hooks.verify({ headers, body, secret: BREVO_FIXTURE_TOKEN, now: Date.now() }),
    ).toEqual({ ok: true });
    expect(hooks.parse(body, headers)).toMatchObject([{ type: "complained" }]);
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const adapter = smtp({ webhooks: brevoWebhooks() });
    const report = await runChecks({ adapter, fixture: smtpFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
