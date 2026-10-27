import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  SCALEWAY_DOMAINS,
  SCALEWAY_FIXTURE_PROJECT_ID,
  SCALEWAY_FIXTURE_SECRET_KEY,
  SCALEWAY_SEND_URL,
  SCALEWAY_VERIFY_URL,
  scalewayAnswer,
  scalewayFixture,
} from "../../src/conformance/fixtures/scaleway";
import { mockFetch } from "../../src/conformance/mock-fetch";
import { scaleway } from "../../src/providers/scaleway/index";

describe("Scaleway adapter (workerd)", () => {
  it("sends and verifies with the X-Auth-Token header", async () => {
    const mock = mockFetch([
      { label: "send", method: "POST", url: SCALEWAY_SEND_URL, response: scalewayAnswer() },
      { label: "verify", method: "GET", url: SCALEWAY_VERIFY_URL, response: SCALEWAY_DOMAINS },
    ]);
    const ctx = {
      fetch: mock.fetch,
      timeoutMs: 5_000,
      credentials: {
        secretKey: SCALEWAY_FIXTURE_SECRET_KEY,
        projectId: SCALEWAY_FIXTURE_PROJECT_ID,
      },
      now: Date.now(),
    };
    const adapter = scaleway();
    const result = await adapter.send(
      {
        from: "billing@example.com",
        to: ["ana@example.org"],
        subject: "Hi",
        text: "Hi",
        attachments: [
          { filename: "a.txt", content: new Uint8Array([104, 105]), contentType: "text/plain" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("sent");
    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    expect(mock.calls.map((call) => call.headers.get("x-auth-token"))).toEqual([
      SCALEWAY_FIXTURE_SECRET_KEY,
      SCALEWAY_FIXTURE_SECRET_KEY,
    ]);
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: scaleway(), fixture: scalewayFixture(), tier: 2 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
