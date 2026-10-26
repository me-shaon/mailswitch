import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/conformance/checks";
import {
  cloudflareBindingBridge,
  cloudflareBindingFixture,
  cloudflareRestFixture,
} from "../../src/conformance/fixtures/cloudflare";
import type { SendContext } from "../../src/core/adapter";
import {
  type CloudflareEmailBuilder,
  type CloudflareSendEmail,
  cloudflareBinding,
  cloudflareRest,
} from "../../src/providers/cloudflare/index";

const noFetch: SendContext["fetch"] = async () => {
  throw new Error("The binding transport must not call fetch.");
};

function ctx(credentials: Record<string, string> = {}): SendContext {
  return { fetch: noFetch, timeoutMs: 1000, credentials, now: Date.now() };
}

// The local structural type accepts the real binding type of @cloudflare/workers-types.
const accepts = (binding: SendEmail): CloudflareSendEmail => binding;

describe("Cloudflare binding transport (workerd)", () => {
  it("sends through a fake send_email binding and keeps its messageId", async () => {
    const sent: CloudflareEmailBuilder[] = [];
    const fake = {
      async send(builder: CloudflareEmailBuilder) {
        sent.push(builder);
        return { messageId: "workerd-message-1" };
      },
    } as unknown as SendEmail;
    const adapter = cloudflareBinding({ env: { EMAIL: accepts(fake) } });
    const result = await adapter.send(
      {
        from: "Acme <billing@example.com>",
        to: ["ana@example.org"],
        subject: "Invoice 42",
        text: "Hello.",
        attachments: [{ filename: "a.txt", content: "aGk=", contentType: "text/plain" }],
      },
      ctx({ bindingName: "EMAIL" }),
    );
    expect(result).toEqual({
      status: "sent",
      provider: "cloudflare-binding",
      providerMessageId: "workerd-message-1",
    });
    expect(sent[0]?.from).toEqual({ email: "billing@example.com", name: "Acme" });
    expect(sent[0]?.attachments?.[0]?.content).toBeInstanceOf(Uint8Array);
  });

  it("gives unknown when the binding throws", async () => {
    const fake: CloudflareSendEmail = {
      async send() {
        throw new Error("binding unavailable");
      },
    };
    const result = await cloudflareBinding(fake).send(
      { from: "billing@example.com", to: ["ana@example.org"], subject: "Hi", text: "Hi" },
      ctx(),
    );
    expect(result.status).toBe("unknown");
  });

  it("passes the conformance suite in the Workers runtime", async () => {
    const binding = await runChecks({
      adapter: cloudflareBindingBridge().adapter,
      fixture: cloudflareBindingFixture(),
      tier: 1,
    });
    expect(binding.checks.filter((entry) => entry.status === "fail")).toEqual([]);
    const rest = await runChecks({
      adapter: cloudflareRest(),
      fixture: cloudflareRestFixture(),
      tier: 1,
    });
    expect(rest.checks.filter((entry) => entry.status === "fail")).toEqual([]);
  });
});
