import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { smtpFixture } from "../../src/conformance/fixtures/smtp";
import { SMTP_CHECK_IDS } from "../../src/conformance/smtp-checks";
import { runConformance } from "../../src/conformance/vitest";
import type { ProviderAdapter } from "../../src/core/adapter";
import { brevoWebhooks } from "../../src/providers/smtp/brevo-webhooks";
import { smtp } from "../../src/providers/smtp/index";

const brevo = () => smtp({ preset: "brevo", webhooks: brevoWebhooks() });

runConformance(brevo(), smtpFixture(), { tier: 1 });
runConformance(smtp(), smtpFixture(), { tier: 1 });

async function failing(adapter: ProviderAdapter): Promise<string[]> {
  const report = await runChecks({ adapter, fixture: smtpFixture(), tier: 1 });
  return report.checks.filter((entry) => entry.status === "fail").map((entry) => entry.id);
}

describe("conformance report of the SMTP adapter", () => {
  it("passes at tier 1 with every SMTP check and Brevo webhooks", async () => {
    const report = await runChecks({ adapter: brevo(), fixture: smtpFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((entry) => entry.id)).toEqual(SMTP_CHECK_IDS);
    expect(
      report.checks
        .filter((entry) => entry.status === "n/a")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["capability.refuse", "idempotency.conflict", "send.idempotency", "webhook.stale"]);
  });

  it("passes without webhooks and marks the webhook checks n/a", async () => {
    const report = await runChecks({ adapter: smtp(), fixture: smtpFixture(), tier: 1 });
    expect(report.ok).toBe(true);
    const na = report.checks.filter((entry) => entry.status === "n/a").map((entry) => entry.id);
    expect(na).toEqual(expect.arrayContaining(["webhook.valid", "events.parse"]));
  });
});

describe("the SMTP form of the kit", () => {
  it("fails an adapter that calls an unknown result not_sent", async () => {
    const base = smtp();
    const ids = await failing({
      ...base,
      async send(message, ctx) {
        const result = await base.send(message, ctx);
        return result.status === "unknown" ? { ...result, status: "not_sent" } : result;
      },
    });
    expect(ids).toContain("send.uncertain");
  });

  it("fails an adapter that puts the password in a result", async () => {
    const base = smtp();
    const ids = await failing({
      ...base,
      async send(message, ctx) {
        const result = await base.send(message, ctx);
        return result.status === "sent"
          ? result
          : { ...result, message: `login ${ctx.credentials.password}` };
      },
    });
    expect(ids).toEqual(["redaction"]);
  });

  it("fails an adapter that calls a failure before DATA unknown", async () => {
    const base = smtp();
    const ids = await failing({
      ...base,
      async send(message, ctx) {
        const result = await base.send(message, ctx);
        return result.status === "not_sent" ? { ...result, status: "unknown" } : result;
      },
    });
    expect(ids).toEqual(
      expect.arrayContaining(["send.auth", "send.invalid", "smtp.before-data", "smtp.tls"]),
    );
  });

  it("fails an adapter that sends AUTH over plain text", async () => {
    const base = smtp();
    const plain = (ctx: Parameters<typeof base.send>[1]) => ({
      ...ctx,
      credentials: { ...ctx.credentials, security: "none", insecure: "true" },
    });
    const ids = await failing({
      ...base,
      send: (message, ctx) => base.send(message, plain(ctx)),
      verify: (ctx) => base.verify(plain(ctx)),
    });
    expect(ids).toEqual(expect.arrayContaining(["send.ok", "smtp.tls", "verify.ok"]));
  });
});
