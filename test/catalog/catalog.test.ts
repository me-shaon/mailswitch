import { describe, expect, it } from "vitest";
import { catalog, getProviderMeta } from "../../src/catalog";
import { classifyResponse, defineStatusMap } from "../../src/core/classify";
import { defineProviderMeta, type ProviderMeta } from "../../src/core/meta";

declare global {
  interface ImportMeta {
    glob(
      pattern: string | string[],
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

// Vite reads the sources as text at transform time, so the test needs no Node APIs.
const sources: Record<string, string> = import.meta.glob(
  ["../../src/catalog/index.ts", "../../src/providers/*/meta.ts"],
  { query: "?raw", import: "default", eager: true },
);

function importsOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
    if (match[1]) found.push(match[1]);
  }
  for (const match of text.matchAll(/import\s*\(\s*["']([^"']+)["']/g)) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}

const ALLOWED =
  /^(\.\.\/core\/(meta|types)|\.\.\/providers\/[a-z0-9-]+\/meta|\.\.\/\.\.\/core\/(meta|classify|types))$/;

describe("catalog", () => {
  it("lists every provider with its tier", () => {
    expect(catalog.map((meta) => [meta.id, meta.tier])).toEqual([
      ["resend", 1],
      ["tosend", 1],
      ["cloudflare-rest", 1],
      ["cloudflare-binding", 1],
      ["mailgun", 1],
      ["postmark", 1],
      ["brevo", 1],
      ["mailersend", 1],
      ["mailjet", 1],
      ["smtp2go", 1],
      ["zeptomail", 2],
      ["sendgrid", 1],
      ["ses", 1],
      ["smtp", 1],
      ["mailchannels", 1],
      ["ahasend", 1],
      ["mailtrap", 1],
      ["autosend", 1],
      ["scaleway", 2],
    ]);
    expect(getProviderMeta("postmark")?.webhooks).toBe(true);
    expect(getProviderMeta("ses")?.name).toBe("Amazon SES");
    expect(getProviderMeta("resend")?.name).toBe("Resend");
    expect(getProviderMeta("tosend")?.capabilities.idempotency).toBe(false);
    expect(getProviderMeta("sendgrid")?.name).toBe("SendGrid");
    expect(getProviderMeta("sendgrid")?.webhooks).toBe(true);
    expect(getProviderMeta("mailchannels")?.name).toBe("MailChannels");
    expect(getProviderMeta("mailchannels")?.capabilities.maxMessageBytes).toBe(30_000_000);
    expect(getProviderMeta("ahasend")?.name).toBe("AhaSend");
    expect(getProviderMeta("ahasend")?.nativeIdempotencyWindowMs).toBe(86_400_000);
    expect(getProviderMeta("mailtrap")?.name).toBe("Mailtrap");
    expect(getProviderMeta("mailtrap")?.capabilities.maxRecipients).toBe(1000);
    expect(getProviderMeta("autosend")?.name).toBe("AutoSend");
    expect(getProviderMeta("autosend")?.capabilities.maxRecipients).toBe(50);
    expect(getProviderMeta("scaleway")?.name).toBe("Scaleway Transactional Email");
    expect(getProviderMeta("scaleway")?.capabilities.maxRecipients).toBe(10);
    expect(getProviderMeta("brevo")?.name).toBe("Brevo");
    expect(getProviderMeta("brevo")?.nativeIdempotencyWindowMs).toBe(1_800_000);
    expect(getProviderMeta("mailersend")?.name).toBe("MailerSend");
    expect(getProviderMeta("mailersend")?.capabilities.maxRecipients).toBe(70);
    expect(getProviderMeta("mailjet")?.capabilities.batchSize).toBe(50);
    expect(getProviderMeta("mailjet")?.credentialFields.map((field) => field.name)).toEqual([
      "apiKey",
      "secretKey",
    ]);
    expect(getProviderMeta("smtp2go")?.name).toBe("SMTP2GO");
    expect(getProviderMeta("smtp2go")?.capabilities.maxMessageBytes).toBe(50_000_000);
    expect(getProviderMeta("zeptomail")?.name).toBe("ZeptoMail");
    expect(getProviderMeta("zeptomail")?.webhooks).toBe(false);
    expect(getProviderMeta("nope")).toBeUndefined();
  });

  it("is frozen", () => {
    expect(Object.isFrozen(catalog)).toBe(true);
    const resend = getProviderMeta("resend");
    expect(Object.isFrozen(resend)).toBe(true);
    expect(Object.isFrozen(resend?.credentialFields[0])).toBe(true);
  });

  it("maps the Resend 409 to unknown", () => {
    const resend = getProviderMeta("resend");
    expect(classifyResponse(409, null, resend?.statusMap)).toMatchObject({
      status: "unknown",
      reason: "idempotency_conflict",
    });
  });

  it("gives the SMTP presets the labels and hints that a settings form shows", () => {
    const smtp = getProviderMeta("smtp");
    const preset = (id: string) => smtp?.presets?.find((entry) => entry.id === id);
    for (const id of ["gmail", "google-workspace"]) {
      expect(preset(id)?.fieldHints?.password?.label).toBe("App password");
      expect(preset(id)?.fieldHints?.password?.hint).toMatch(/2-Step Verification/);
    }
    expect(preset("brevo")?.fieldHints?.password).toMatchObject({ label: "SMTP key" });
    expect(preset("brevo")?.fieldHints?.password?.hint).toMatch(/API key does not work/);
    for (const id of ["mailpit", "mailcrab"]) {
      expect(preset(id)?.fieldHints?.host?.hint).toMatch(/Local development only/);
    }
    for (const field of smtp?.credentialFields ?? []) {
      expect(field.label.length, field.name).toBeGreaterThan(3);
    }
  });

  it("imports only meta files", () => {
    const files = Object.keys(sources);
    expect(files).toContain("../../src/catalog/index.ts");
    expect(files).toContain("../../src/providers/resend/meta.ts");
    expect(files).toContain("../../src/providers/tosend/meta.ts");
    expect(files).toContain("../../src/providers/cloudflare/meta.ts");
    expect(files).toContain("../../src/providers/mailgun/meta.ts");
    expect(files).toContain("../../src/providers/postmark/meta.ts");
    expect(files).toContain("../../src/providers/brevo/meta.ts");
    expect(files).toContain("../../src/providers/mailersend/meta.ts");
    expect(files).toContain("../../src/providers/mailjet/meta.ts");
    expect(files).toContain("../../src/providers/smtp2go/meta.ts");
    expect(files).toContain("../../src/providers/zeptomail/meta.ts");
    expect(files).toContain("../../src/providers/sendgrid/meta.ts");
    expect(files).toContain("../../src/providers/ses/meta.ts");
    expect(files).toContain("../../src/providers/smtp/meta.ts");
    expect(files).toContain("../../src/providers/mailchannels/meta.ts");
    expect(files).toContain("../../src/providers/ahasend/meta.ts");
    expect(files).toContain("../../src/providers/mailtrap/meta.ts");
    expect(files).toContain("../../src/providers/autosend/meta.ts");
    expect(files).toContain("../../src/providers/scaleway/meta.ts");
    for (const [file, text] of Object.entries(sources)) {
      for (const spec of importsOf(text)) {
        expect(spec, `${file} imports ${spec}`).toMatch(ALLOWED);
        expect(spec).not.toMatch(/internal|\/index$/);
      }
    }
  });
});

const base: ProviderMeta = {
  id: "example",
  name: "Example",
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
  credentialFields: [{ name: "apiKey", label: "API key", secret: true, required: true }],
  docsUrl: "https://example.com/docs",
  statusMap: {},
  nativeIdempotency: false,
};

describe("defineProviderMeta", () => {
  it("throws for a tier 2 provider with a 5xx not_sent override", () => {
    const statusMap = defineStatusMap({
      503: { status: "not_sent", reason: "provider_error", source: "https://example.com/503" },
    });
    expect(() => defineProviderMeta({ ...base, statusMap })).toThrow(/tier 2/);
    expect(() => defineProviderMeta({ ...base, tier: 1, statusMap })).not.toThrow();
  });

  it("throws for a duplicate field name", () => {
    const field = base.credentialFields[0];
    if (!field) throw new Error("no field");
    expect(() => defineProviderMeta({ ...base, credentialFields: [field, field] })).toThrow(
      /used twice/,
    );
  });

  it("throws for an invalid pattern and a bad tier", () => {
    expect(() =>
      defineProviderMeta({
        ...base,
        credentialFields: [{ name: "k", label: "K", secret: false, required: true, pattern: "(" }],
      }),
    ).toThrow(/pattern/);
    expect(() => defineProviderMeta({ ...base, tier: 3 as 1 })).toThrow(/tier/);
  });

  it("checks nativeIdempotencyWindowMs", () => {
    const native: ProviderMeta = {
      ...base,
      capabilities: { ...base.capabilities, idempotency: true },
      nativeIdempotency: true,
    };
    const window = 30 * 60 * 1000;
    expect(defineProviderMeta({ ...native, nativeIdempotencyWindowMs: window })).toMatchObject({
      nativeIdempotencyWindowMs: window,
    });
    expect(() => defineProviderMeta({ ...base, nativeIdempotencyWindowMs: window })).toThrow(
      TypeError,
    );
    expect(() => defineProviderMeta({ ...base, nativeIdempotencyWindowMs: window })).toThrow(
      /nativeIdempotency must be true/,
    );
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => defineProviderMeta({ ...native, nativeIdempotencyWindowMs: bad })).toThrow(
        /a positive integer/,
      );
    }
  });

  it("throws for a preset that names an unknown field", () => {
    expect(() =>
      defineProviderMeta({ ...base, presets: [{ id: "p", name: "P", fixed: { host: "x" } }] }),
    ).toThrow(/unknown field/);
  });
});
