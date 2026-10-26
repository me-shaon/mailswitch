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
  it("lists Resend, toSend, both Cloudflare transports, and Mailgun at tier 1", () => {
    expect(catalog.map((meta) => [meta.id, meta.tier])).toEqual([
      ["resend", 1],
      ["tosend", 1],
      ["cloudflare-rest", 1],
      ["cloudflare-binding", 1],
      ["mailgun", 1],
    ]);
    expect(getProviderMeta("resend")?.name).toBe("Resend");
    expect(getProviderMeta("tosend")?.capabilities.idempotency).toBe(false);
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

  it("imports only meta files", () => {
    const files = Object.keys(sources);
    expect(files).toContain("../../src/catalog/index.ts");
    expect(files).toContain("../../src/providers/resend/meta.ts");
    expect(files).toContain("../../src/providers/tosend/meta.ts");
    expect(files).toContain("../../src/providers/cloudflare/meta.ts");
    expect(files).toContain("../../src/providers/mailgun/meta.ts");
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

  it("throws for a preset that names an unknown field", () => {
    expect(() =>
      defineProviderMeta({ ...base, presets: [{ id: "p", name: "P", fixed: { host: "x" } }] }),
    ).toThrow(/unknown field/);
  });
});
