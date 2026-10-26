// The precedence of a credential field under createMailer: the preset fixed value, then
// a value in the credentials, then the adapter option, then the field default.

import { describe, expect, it } from "vitest";
import { mockFetch } from "../../src/conformance/mock-fetch";
import { mockSmtp } from "../../src/conformance/mock-smtp";
import { defineProvider, type SendContext } from "../../src/core/adapter";
import { checkCredentials, parseCredentials } from "../../src/core/credentials";
import { defineProviderMeta } from "../../src/core/meta";
import { createMailer, type MailerProvider } from "../../src/core/pipeline";
import type { OutgoingMessage } from "../../src/core/types";
import { cloudflareBinding } from "../../src/providers/cloudflare/index";
import { MAILGUN_REGIONS, mailgun } from "../../src/providers/mailgun/index";
import { smtp, smtpMeta } from "../../src/providers/smtp/index";

const USER = "sender@example.com";
const PASS = "app-password-1";
const LOGIN = { username: USER, password: PASS };

const message: OutgoingMessage = {
  from: "sender@example.com",
  to: ["ana@example.org"],
  subject: "Hello",
  text: "Hello.",
};

const quiet = { warn: () => undefined };

async function sendSmtp(provider: Omit<MailerProvider, "credentials">, credentials: object) {
  const mock = mockSmtp({ ...LOGIN, starttls: true });
  const mailer = createMailer({
    providers: [{ ...provider, credentials: credentials as Record<string, unknown> }],
    connect: mock.connect,
    logger: quiet,
  });
  const result = await mailer.send(message);
  return { result, target: mock.sessions[0]?.target };
}

describe("checkCredentials", () => {
  it("fills the defaults and names the defaulted fields", () => {
    expect(checkCredentials(smtpMeta, { host: "smtp.example.com", security: "tls" })).toEqual({
      ok: true,
      values: { preset: "custom", host: "smtp.example.com", security: "tls", insecure: "false" },
      defaulted: new Set(["preset", "insecure"]),
    });
    expect(checkCredentials(smtpMeta, { host: "h.example.com", security: "bad" })).toEqual({
      ok: false,
      errors: [{ field: "security", code: "option" }],
    });
  });

  it("does not mark the preset fixed values as defaulted", () => {
    expect(checkCredentials(smtpMeta, { host: "localhost" }, "mailpit")).toEqual({
      ok: true,
      values: { preset: "mailpit", host: "localhost", security: "none", insecure: "true" },
      defaulted: new Set(),
    });
  });

  it("leaves parseCredentials unchanged: it still fills the defaults", () => {
    expect(parseCredentials(smtpMeta, { host: "smtp.example.com" })).toEqual({
      ok: true,
      values: {
        preset: "custom",
        host: "smtp.example.com",
        security: "starttls",
        insecure: "false",
      },
    });
  });
});

describe("SMTP options under createMailer", () => {
  it("applies the preset option when the credentials do not set a preset", async () => {
    const { result, target } = await sendSmtp(
      { adapter: smtp({ preset: "gmail" }) },
      { host: "other.example.com", ...LOGIN },
    );
    expect(result.status).toBe("sent");
    expect(target).toEqual({ hostname: "smtp.gmail.com", port: 587, secureTransport: "starttls" });
  });

  it("applies the security option when the credentials do not set security", async () => {
    const { result, target } = await sendSmtp(
      { adapter: smtp({ security: "tls" }) },
      { host: "smtp.example.com", ...LOGIN },
    );
    expect(result.status).toBe("sent");
    expect(target).toEqual({ hostname: "smtp.example.com", port: 465, secureTransport: "on" });
  });

  it("lets an explicit credential beat the option", async () => {
    const { target } = await sendSmtp(
      { adapter: smtp({ preset: "gmail", security: "tls" }) },
      { preset: "custom", security: "starttls", host: "smtp.example.com", ...LOGIN },
    );
    expect(target).toEqual({
      hostname: "smtp.example.com",
      port: 587,
      secureTransport: "starttls",
    });
  });

  it("uses the field defaults when neither the credentials nor the options set a value", async () => {
    const { target } = await sendSmtp({ adapter: smtp() }, { host: "smtp.example.com", ...LOGIN });
    expect(target).toEqual({
      hostname: "smtp.example.com",
      port: 587,
      secureTransport: "starttls",
    });
  });

  it("still needs insecure for plain text, from the credentials or the options", async () => {
    const plain = await sendSmtp(
      { adapter: smtp({ security: "none" }) },
      { host: "smtp.example.com", ...LOGIN },
    );
    expect(plain.result).toMatchObject({ status: "not_sent" });
    expect(plain.target?.secureTransport).not.toBe("off");
    const refused = await sendSmtp(
      { adapter: smtp({ security: "none", insecure: true }) },
      { host: "smtp.example.com", insecure: "false", ...LOGIN },
    );
    expect(refused.result).toMatchObject({ status: "not_sent" });
  });

  it("keeps the fixed values of a local preset over the credentials and the options", async () => {
    const viaOption = await sendSmtp(
      { adapter: smtp({ preset: "mailpit", security: "tls", insecure: false }) },
      { host: "localhost" },
    );
    expect(viaOption.target).toEqual({ hostname: "localhost", port: 1025, secureTransport: "off" });
    const viaEntry = await sendSmtp(
      { adapter: smtp({ security: "tls" }), preset: "mailcrab" },
      { host: "localhost", security: "tls", insecure: "false" },
    );
    expect(viaEntry.target).toEqual({ hostname: "localhost", port: 1025, secureTransport: "off" });
  });
});

describe("Mailgun region under createMailer", () => {
  const KEY = "test-mailgun-api-key-not-a-real-secret";
  const queued = { id: "<1@mg.example.com>", message: "Queued. Thank you." };

  async function sendTo(origin: string, adapter = mailgun(), credentials: object = {}) {
    const mock = mockFetch([
      {
        label: "send",
        method: "POST",
        url: `${origin}/v3/mg.example.com/messages`,
        response: { status: 200, body: queued },
      },
    ]);
    const mailer = createMailer({
      providers: [
        { adapter, credentials: { apiKey: KEY, domain: "mg.example.com", ...credentials } },
      ],
      fetch: mock.fetch,
      logger: quiet,
    });
    return mailer.send(message);
  }

  it("applies the region option when the credentials do not set a region", async () => {
    expect((await sendTo(MAILGUN_REGIONS.eu, mailgun({ region: "eu" }))).status).toBe("sent");
  });

  it("lets an explicit region credential beat the option", async () => {
    const result = await sendTo(MAILGUN_REGIONS.us, mailgun({ region: "eu" }), { region: "us" });
    expect(result.status).toBe("sent");
  });

  it("uses the US region when neither sets one", async () => {
    expect((await sendTo(MAILGUN_REGIONS.us)).status).toBe("sent");
  });
});

describe("Cloudflare binding name under createMailer", () => {
  it("uses the default binding name when the credentials leave it empty", async () => {
    const binding = { send: async () => ({ messageId: "m-1" }) };
    const mailer = createMailer({
      providers: [{ adapter: cloudflareBinding({ env: { EMAIL: binding } }), credentials: {} }],
      logger: quiet,
    });
    expect((await mailer.send(message)).status).toBe("sent");
  });
});

describe("custom adapters under createMailer", () => {
  it("still get the field default in the credentials", async () => {
    const seen: SendContext[] = [];
    const meta = defineProviderMeta({
      ...smtpMeta,
      id: "custom-region",
      name: "Custom",
      credentialFields: [
        { name: "apiKey", label: "Key", secret: true, required: true },
        { name: "region", label: "Region", secret: false, required: false, defaultValue: "us" },
      ],
      presets: undefined,
    });
    const adapter = defineProvider({
      meta,
      send: async (_message, ctx) => {
        seen.push(ctx);
        return { status: "sent", provider: "custom-region" };
      },
      verify: async () => ({ ok: true }),
    });
    const mailer = createMailer({
      providers: [{ adapter, credentials: { apiKey: "k" } }],
      logger: quiet,
    });
    expect((await mailer.send(message)).status).toBe("sent");
    expect(seen[0]?.credentials).toEqual({ apiKey: "k", region: "us" });
    expect(seen[0]?.defaultedFields).toEqual(new Set(["region"]));
  });
});
