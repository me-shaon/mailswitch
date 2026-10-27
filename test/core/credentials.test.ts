import { describe, expect, it } from "vitest";
import { getProviderMeta } from "../../src/catalog";
import { parseCredentials } from "../../src/core/credentials";
import { defineProviderMeta, type ProviderMeta } from "../../src/core/meta";

function resend(): ProviderMeta {
  const meta = getProviderMeta("resend");
  if (!meta) throw new Error("resend is missing");
  return meta;
}

const smtp: ProviderMeta = defineProviderMeta({
  id: "smtp-example",
  name: "SMTP example",
  tier: 2,
  capabilities: {
    attachments: true,
    maxMessageBytes: null,
    cc: true,
    bcc: true,
    replyTo: true,
    customHeaders: true,
    idempotency: false,
    batchSize: 1,
  },
  credentialFields: [
    { name: "host", label: "Host", secret: false, required: true },
    {
      name: "port",
      label: "Port",
      secret: false,
      required: false,
      defaultValue: "587",
      pattern: "^\\d+$",
    },
    {
      name: "security",
      label: "Security",
      secret: false,
      required: false,
      defaultValue: "starttls",
      options: [
        { value: "starttls", label: "STARTTLS" },
        { value: "tls", label: "TLS" },
      ],
    },
    { name: "password", label: "Password", secret: true, required: true },
  ],
  presets: [
    {
      id: "gmail",
      name: "Gmail",
      fixed: { host: "smtp.gmail.com", port: "465", security: "tls" },
      defaultDailyCap: 500,
    },
  ],
  docsUrl: "https://example.com/smtp",
  statusMap: {},
  nativeIdempotency: false,
});

describe("parseCredentials", () => {
  it("accepts a valid key", () => {
    expect(parseCredentials(resend(), { apiKey: " re_abc123 ", extra: "x" })).toEqual({
      ok: true,
      values: { apiKey: "re_abc123" },
    });
  });

  it("rejects a missing required field", () => {
    expect(parseCredentials(resend(), {})).toEqual({
      ok: false,
      errors: [{ field: "apiKey", code: "required" }],
    });
    expect(parseCredentials(resend(), { apiKey: "  " })).toMatchObject({ ok: false });
  });

  it("rejects an invalid pattern without the secret value in the error", () => {
    const secret = "sk_live_TOPSECRET_9f8e7d";
    const result = parseCredentials(resend(), { apiKey: secret });
    expect(result).toEqual({ ok: false, errors: [{ field: "apiKey", code: "pattern" }] });
    expect(JSON.stringify(result)).not.toContain("TOPSECRET");
    expect(String(result)).not.toContain("TOPSECRET");
  });

  it("rejects a value of the wrong type", () => {
    expect(parseCredentials(resend(), { apiKey: 42 })).toEqual({
      ok: false,
      errors: [{ field: "apiKey", code: "type" }],
    });
  });

  it("applies defaults and checks options", () => {
    expect(parseCredentials(smtp, { host: "mail.example.com", password: "pw" })).toEqual({
      ok: true,
      values: { host: "mail.example.com", port: "587", security: "starttls", password: "pw" },
    });
    expect(parseCredentials(smtp, { host: "h", password: "pw", security: "none" })).toEqual({
      ok: false,
      errors: [{ field: "security", code: "option" }],
    });
  });

  it("applies preset fixed values over the input", () => {
    expect(parseCredentials(smtp, { host: "other", port: "25", password: "pw" }, "gmail")).toEqual({
      ok: true,
      values: { host: "smtp.gmail.com", port: "465", security: "tls", password: "pw" },
    });
  });

  it("refuses an unknown preset id without a throw", () => {
    expect(parseCredentials(smtp, {}, "nope")).toEqual({
      ok: false,
      errors: [{ field: "preset", code: "preset" }],
    });
  });
});
