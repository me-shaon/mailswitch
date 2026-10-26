// The F1 settings flow, end to end in workerd: pick a provider from the catalog, check
// the form input, verify the key, send a test email, and store the credentials encrypted.

import { describe, expect, it } from "vitest";
import { getProviderMeta } from "../../src/catalog/index";
import { mockFetch } from "../../src/conformance/index";
import { createKeyRing, decrypt, encrypt } from "../../src/crypto/index";
import { parseCredentials, type SendContext, sendTestEmail } from "../../src/index";
import { resend } from "../../src/providers/resend/index";

const API = "https://api.resend.com";
const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

describe("settings flow (workerd)", () => {
  it("runs catalog, form, verify, test send, and encrypt", async () => {
    const meta = getProviderMeta("resend");
    if (!meta) throw new Error("resend is not in the catalog");

    const parsed = parseCredentials(meta, { apiKey: "  re_test_0123456789  " });
    if (!parsed.ok) throw new Error("the credentials did not parse");
    expect(parsed.values).toEqual({ apiKey: "re_test_0123456789" });

    const mock = mockFetch([
      {
        label: "verify",
        method: "GET",
        url: `${API}/domains`,
        response: { status: 200, body: { data: [] } },
      },
      {
        label: "test send",
        method: "POST",
        url: `${API}/emails`,
        response: { status: 200, body: { id: ID } },
      },
    ]);
    const ctx: SendContext = {
      fetch: mock.fetch,
      timeoutMs: 1000,
      credentials: parsed.values,
      now: Date.now(),
    };
    const adapter = resend();

    expect(await adapter.verify(ctx)).toEqual({ ok: true });
    const result = await sendTestEmail(adapter, ctx, {
      from: "Acme <hello@example.com>",
      to: "ana@example.org",
    });
    expect(result).toEqual({ status: "sent", provider: "resend", providerMessageId: ID });
    expect(mock.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    const sent = JSON.parse(mock.calls[1]?.body ?? "{}") as { subject?: string };
    expect(sent.subject).toBe("mailswitch test email");
    expect(mock.calls[1]?.headers.get("idempotency-key")).toMatch(/^mailswitch-test-/);

    const ring = createKeyRing({
      keys: [{ version: 1, secret: crypto.getRandomValues(new Uint8Array(32)) }],
      current: 1,
    });
    const scope = ["workspace", "42", meta.id];
    const stored = await encrypt(ring, JSON.stringify(parsed.values), scope);
    expect(stored).not.toContain("re_test_0123456789");
    expect(JSON.parse(await decrypt(ring, stored, scope))).toEqual(parsed.values);
  });
});
