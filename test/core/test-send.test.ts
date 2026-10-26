import { describe, expect, it } from "vitest";
import type { SendContext } from "../../src/core/adapter";
import { sendTestEmail, TEST_EMAIL_SUBJECT, TEST_EMAIL_TEXT } from "../../src/index";
import { fakeProvider } from "../../src/testing/index";

const ctx = (): SendContext => ({
  fetch: () => Promise.reject(new TypeError("no network")),
  timeoutMs: 1000,
  credentials: {},
  now: Date.parse("2026-10-26T12:00:00.000Z"),
});

describe("sendTestEmail", () => {
  it("sends one fixed message and returns its result", async () => {
    const fake = fakeProvider();
    const result = await sendTestEmail(fake, ctx(), {
      from: "Acme <hello@example.com>",
      to: "ana@example.org",
    });
    expect(fake.sends).toHaveLength(1);
    const sent = fake.sends[0];
    expect(result).toEqual(sent?.result);
    expect(result.status).toBe("sent");
    expect(sent?.message).toMatchObject({
      from: "Acme <hello@example.com>",
      to: ["ana@example.org"],
      subject: TEST_EMAIL_SUBJECT,
      text: TEST_EMAIL_TEXT,
    });
    expect(TEST_EMAIL_SUBJECT).toBe("mailswitch test email");
    expect(sent?.message.html).toBeUndefined();
    expect(sent?.message.idempotencyKey).toMatch(/^mailswitch-test-[0-9a-f-]{36}$/);
  });

  it("uses a new idempotency key per call and accepts a custom subject and text", async () => {
    const fake = fakeProvider();
    const options = { from: "hello@example.com", to: "ana@example.org" };
    await sendTestEmail(fake, ctx(), options);
    await sendTestEmail(fake, ctx(), { ...options, subject: "Hi", text: "Body" });
    const [first, second] = fake.sends;
    expect(first?.message.idempotencyKey).not.toBe(second?.message.idempotencyKey);
    expect(second?.message).toMatchObject({ subject: "Hi", text: "Body" });
  });

  it("returns a failure as a result", async () => {
    const fake = fakeProvider({ outcomes: ["not_sent"] });
    const result = await sendTestEmail(fake, ctx(), {
      from: "hello@example.com",
      to: "ana@example.org",
    });
    expect(result.status).toBe("not_sent");
  });
});
