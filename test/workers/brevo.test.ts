import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { BREVO_FIXTURE_API_KEY, brevoFixture } from "../../src/conformance/fixtures/brevo";
import { BREVO_FIXTURE_TOKEN, brevoEvent } from "../../src/conformance/fixtures/smtp";
import { mockFetch } from "../../src/conformance/mock-fetch";
import { uuidFromKey } from "../../src/internal/uuid";
import { BREVO_API_BASE, brevo } from "../../src/providers/brevo/index";
import { MemoryDedupeStore } from "../../src/stores/memory";
import { handleWebhook } from "../../src/webhooks/index";

describe("Brevo (workerd)", () => {
  it("derives the idempotency UUID with Web Crypto and sends it in the body", async () => {
    const mock = mockFetch([
      {
        label: "send",
        method: "POST",
        url: `${BREVO_API_BASE}/v3/smtp/email`,
        response: { status: 201, body: { messageId: "<1@smtp-relay.mailin.fr>" } },
      },
    ]);
    const result = await brevo().send(
      {
        from: "billing@example.com",
        to: ["ana@example.org"],
        subject: "Invoice",
        text: "Hello.",
        idempotencyKey: "invoice-42",
      },
      {
        fetch: mock.fetch,
        timeoutMs: 5_000,
        credentials: { apiKey: BREVO_FIXTURE_API_KEY },
        now: Date.now(),
      },
    );
    expect(result).toMatchObject({ status: "sent", provider: "brevo" });
    const body = JSON.parse(mock.calls[0]?.body ?? "{}") as { headers?: Record<string, string> };
    expect(body.headers?.idempotencyKey).toBe(await uuidFromKey("invoice-42"));
  });

  it("drops a replay through handleWebhook", async () => {
    const dedupe = new MemoryDedupeStore();
    const adapter = brevo();
    const send = () =>
      handleWebhook(
        new Request("https://app.example.com/hooks/brevo", {
          method: "POST",
          headers: { authorization: `Bearer ${BREVO_FIXTURE_TOKEN}` },
          body: JSON.stringify(brevoEvent("soft_bounce", "ana@example.org")),
        }),
        { adapter, secret: BREVO_FIXTURE_TOKEN, dedupe },
      );
    const first = await send();
    if (!first.ok) throw new Error(first.rejection);
    expect(first.events).toMatchObject([{ type: "bounced", bounce: "soft", provider: "brevo" }]);
    await first.ack();
    expect(await send()).toMatchObject({ ok: true, events: [] });
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: brevo(), fixture: brevoFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
