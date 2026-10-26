import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import { toSendBounce, toSendFixture } from "../../src/conformance/fixtures/tosend";
import { bytesToHex, utf8 } from "../../src/internal/encoding";
import { toSendSignature, tosend } from "../../src/providers/tosend/index";

const SECRET = "tosend-webhook-secret-0123456789";

describe("toSend webhooks (workerd)", () => {
  it("verifies the signature over the raw bytes and refuses a wrong secret", async () => {
    const hooks = tosend().webhooks;
    const body = utf8(toSendBounce("ana@example.org"));
    const headers = new Headers({ "x-tosend-signature": await toSendSignature(SECRET, body) });
    const now = Date.now();
    expect(await hooks.verify({ headers, body, secret: SECRET, now })).toEqual({ ok: true });
    expect(await hooks.verify({ headers, body, secret: "wrong", now })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    expect(hooks.parse(body, headers)[0]?.eventKey).toBe(bytesToHex(digest));
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const report = await runChecks({ adapter: tosend(), fixture: toSendFixture(), tier: 1 });
    expect(report.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
