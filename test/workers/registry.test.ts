// The registry in workerd: build an adapter from a saved id, then send through it with
// createMailer and a mocked fetch.

import { describe, expect, it } from "vitest";
import { isProviderId } from "../../src/catalog/index";
import { mockFetch } from "../../src/conformance/index";
import { createMailer } from "../../src/index";
import { createAdapter } from "../../src/registry/index";

const API = "https://api.resend.com";
const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

describe("registry (workerd)", () => {
  it("builds the resend adapter from a saved id and sends through createMailer", async () => {
    const saved = "resend";
    if (!isProviderId(saved)) throw new Error("resend is not a provider id");
    const adapter = await createAdapter(saved, {});
    expect(adapter.meta.id).toBe("resend");

    const mock = mockFetch([
      {
        label: "send",
        method: "POST",
        url: `${API}/emails`,
        response: { status: 200, body: { id: ID } },
      },
    ]);
    const mailer = createMailer({
      providers: [{ adapter, credentials: { apiKey: "re_test_0123456789" } }],
      fetch: mock.fetch,
    });
    const result = await mailer.send({
      from: "Acme <hello@example.com>",
      to: ["ana@example.org"],
      subject: "Hello",
      text: "Hello from the registry.",
    });
    expect(result).toMatchObject({ status: "sent", provider: "resend", providerMessageId: ID });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.headers.get("authorization")).toBe("Bearer re_test_0123456789");
  });
});
