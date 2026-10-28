import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { getProviderMeta, PROVIDER_IDS, type ProviderId } from "../../src/catalog/index";
import { HTTP_FIXTURE_ALLOW_HOSTS, httpFixtureConfig } from "../../src/conformance/fixtures/http";
import type { ProviderAdapter, ProviderWebhooks } from "../../src/core/adapter";
import type { PostmarkAdapter } from "../../src/providers/postmark/index";
import type { SmtpWebhookAdapter } from "../../src/providers/smtp/index";
import {
  createAdapter,
  REGISTRY_CREDENTIAL_KEYS,
  type RegistryFactoryOptions,
  type RegistryOptions,
} from "../../src/registry/index";
import { loadNode, type NodeApis } from "../scaffold/node";

declare global {
  interface ImportMeta {
    url: string;
    glob(
      pattern: string | string[],
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

// Vite reads the source as text at transform time.
const sources: Record<string, string> = import.meta.glob("../../src/registry/index.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SOURCE = Object.values(sources)[0] ?? "";

/** A value that must never reach an error message. */
const SECRET = "re_live_not_real_but_secret";

/** A fake `send_email` binding. */
const BINDING = { send: async () => ({ messageId: "fake" }) };

/** The options of each id in the adapter test. `http` has its own test. */
function optionsOf(id: ProviderId): unknown {
  return id === "cloudflare-binding" ? { binding: BINDING } : {};
}

/** The directory of the provider module of each id. */
function moduleOf(id: ProviderId): string {
  return id.startsWith("cloudflare-") ? "cloudflare" : id;
}

/**
 * Lists every key of the factory options of one id. The `Record` type makes the list
 * exact: a missing key and an extra key are both type errors.
 */
function keysOf<T>(keys: Record<keyof T & string, true>): string[] {
  return Object.keys(keys);
}

const FACTORY_OPTION_KEYS: { [Id in ProviderId]: string[] } = {
  resend: keysOf<RegistryFactoryOptions["resend"]>({ apiKey: true, baseUrl: true }),
  tosend: keysOf<RegistryFactoryOptions["tosend"]>({ apiKey: true, baseUrl: true }),
  "cloudflare-rest": keysOf<RegistryFactoryOptions["cloudflare-rest"]>({
    accountId: true,
    apiToken: true,
    baseUrl: true,
  }),
  "cloudflare-binding": keysOf<RegistryFactoryOptions["cloudflare-binding"]>({ binding: true }),
  mailgun: keysOf<RegistryFactoryOptions["mailgun"]>({
    apiKey: true,
    domain: true,
    region: true,
    baseUrl: true,
  }),
  postmark: keysOf<RegistryFactoryOptions["postmark"]>({
    serverToken: true,
    messageStream: true,
    baseUrl: true,
    webhookUsername: true,
    previousWebhookSecret: true,
  }),
  brevo: keysOf<RegistryFactoryOptions["brevo"]>({ apiKey: true, baseUrl: true, sandbox: true }),
  mailersend: keysOf<RegistryFactoryOptions["mailersend"]>({ apiKey: true, baseUrl: true }),
  mailjet: keysOf<RegistryFactoryOptions["mailjet"]>({
    apiKey: true,
    secretKey: true,
    baseUrl: true,
    sandbox: true,
    webhookUsername: true,
    previousWebhookSecret: true,
  }),
  smtp2go: keysOf<RegistryFactoryOptions["smtp2go"]>({
    apiKey: true,
    region: true,
    baseUrl: true,
    webhookUsername: true,
    previousWebhookSecret: true,
  }),
  zeptomail: keysOf<RegistryFactoryOptions["zeptomail"]>({
    token: true,
    region: true,
    fromAddress: true,
  }),
  sendgrid: keysOf<RegistryFactoryOptions["sendgrid"]>({
    apiKey: true,
    baseUrl: true,
    sandbox: true,
  }),
  ses: keysOf<RegistryFactoryOptions["ses"]>({
    region: true,
    accessKeyId: true,
    secretAccessKey: true,
    sessionToken: true,
    configurationSetName: true,
    endpoint: true,
    snsMaxAgeMs: true,
    requireSignatureVersion2: true,
    certTimeoutMs: true,
    maxCertBytes: true,
  }),
  smtp: keysOf<RegistryFactoryOptions["smtp"]>({
    preset: true,
    host: true,
    port: true,
    security: true,
    insecure: true,
    username: true,
    password: true,
    heloName: true,
    connect: true,
    webhooks: true,
  }),
  mailchannels: keysOf<RegistryFactoryOptions["mailchannels"]>({
    apiKey: true,
    baseUrl: true,
    dryRun: true,
    customerHandle: true,
  }),
  ahasend: keysOf<RegistryFactoryOptions["ahasend"]>({
    apiKey: true,
    accountId: true,
    baseUrl: true,
    sandbox: true,
  }),
  mailtrap: keysOf<RegistryFactoryOptions["mailtrap"]>({
    apiKey: true,
    stream: true,
    sandboxInboxId: true,
    baseUrl: true,
    accountsUrl: true,
  }),
  autosend: keysOf<RegistryFactoryOptions["autosend"]>({
    apiKey: true,
    projectId: true,
    baseUrl: true,
  }),
  scaleway: keysOf<RegistryFactoryOptions["scaleway"]>({
    secretKey: true,
    projectId: true,
    baseUrl: true,
  }),
  http: keysOf<RegistryFactoryOptions["http"]>({ config: true, allowHosts: true }),
};

/** Each credential key must be a key of the factory options. A wrong key is a type error. */
type CheckKeys<
  T extends { readonly [Id in ProviderId]: readonly (keyof RegistryFactoryOptions[Id])[] },
> = T;
expectTypeOf<CheckKeys<typeof REGISTRY_CREDENTIAL_KEYS>>().toEqualTypeOf(REGISTRY_CREDENTIAL_KEYS);

describe("createAdapter", () => {
  for (const id of PROVIDER_IDS.filter((entry) => entry !== "http")) {
    it(`builds the ${id} adapter`, async () => {
      const adapter = await createAdapter(id as "resend", optionsOf(id) as never);
      expect(adapter.meta.id).toBe(id);
    });
  }

  it("builds the http adapter from a JSON config", async () => {
    const config = httpFixtureConfig();
    const adapter = await createAdapter("http", { config, allowHosts: HTTP_FIXTURE_ALLOW_HOSTS });
    expect(adapter.meta.id).toBe(config.id);
  });

  it("builds the smtp adapter with relay webhooks", async () => {
    const webhooks: ProviderWebhooks = {
      verify: async () => ({ ok: true }),
      parse: () => [],
    } as unknown as ProviderWebhooks;
    const adapter = await createAdapter("smtp", { webhooks });
    expect(adapter.meta.webhooks).toBe(true);
    expect(adapter.requiresDedupe).toBe(true);
  });

  it("throws a TypeError at once for an unknown id, with no option value", () => {
    for (const id of ["nope", "toString", "__proto__", "constructor", ""]) {
      let thrown: unknown;
      try {
        createAdapter(id as "resend", { apiKey: SECRET } as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      const message = (thrown as Error).message;
      expect(message).toContain(JSON.stringify(id));
      expect(message).not.toContain(SECRET);
    }
    expect(() => createAdapter(42 as unknown as "resend")).toThrow(TypeError);
  });

  it("rejects with the factory TypeError for an http host outside allowHosts", async () => {
    const config = { ...httpFixtureConfig(), endpoint: "https://evil.example.test/send" };
    const pending = createAdapter("http", { config, allowHosts: HTTP_FIXTURE_ALLOW_HOSTS });
    await expect(pending).rejects.toThrow(TypeError);
    await expect(pending).rejects.toThrow(/allowHosts/);
  });

  it("rejects missing options for cloudflare-binding and http", async () => {
    await expect(createAdapter("http", undefined as never)).rejects.toThrow(TypeError);
    await expect(createAdapter("cloudflare-binding", undefined as never)).rejects.toThrow(
      TypeError,
    );
    await expect(createAdapter("cloudflare-binding", { binding: {} } as never)).rejects.toThrow(
      TypeError,
    );
  });

  it("rejects a credential in the options, with no credential value", async () => {
    const pending = createAdapter("resend", { apiKey: SECRET } as never);
    await expect(pending).rejects.toThrow(TypeError);
    const error = await pending.catch((reason: unknown) => reason);
    expect((error as Error).message).toContain("apiKey");
    expect((error as Error).message).not.toContain(SECRET);
  });

  it("types the options and the adapter per id", () => {
    // The checks run in the type checker. The function never runs.
    const types = (): void => {
      // @ts-expect-error apiKey is a credential. It goes to createMailer.
      void createAdapter("resend", { apiKey: "re_x" });
      // @ts-expect-error http needs { config, allowHosts }.
      void createAdapter("http");
      // @ts-expect-error cloudflare-binding needs { binding }.
      void createAdapter("cloudflare-binding");
      // @ts-expect-error host is an smtp credential.
      void createAdapter("smtp", { host: "smtp.example.com" });
      void createAdapter("resend");
      void createAdapter("resend", { baseUrl: "https://proxy.example.com" });
      expectTypeOf(createAdapter("postmark")).resolves.toEqualTypeOf<PostmarkAdapter>();
      expectTypeOf(createAdapter("postmark")).resolves.toHaveProperty("webhooks");
      const webhooks = {} as ProviderWebhooks;
      expectTypeOf(
        createAdapter("smtp", { webhooks }),
      ).resolves.toEqualTypeOf<SmtpWebhookAdapter>();
      expectTypeOf(
        createAdapter("smtp", { heloName: "mail.example.com" }),
      ).resolves.toEqualTypeOf<ProviderAdapter>();
      expectTypeOf<RegistryOptions<"smtp">>().toEqualTypeOf<
        Omit<RegistryFactoryOptions["smtp"], (typeof REGISTRY_CREDENTIAL_KEYS)["smtp"][number]>
      >();
      expectTypeOf<keyof RegistryOptions<"smtp">>().toEqualTypeOf<
        "heloName" | "connect" | "webhooks"
      >();
    };
    expect(typeof types).toBe("function");
  });

  it("types a dynamic ProviderId with no casts", () => {
    // The checks run in the type checker. The function never runs.
    const types = (saved: ProviderId, options?: RegistryOptions<ProviderId>): void => {
      expectTypeOf(createAdapter(saved)).resolves.toExtend<ProviderAdapter>();
      expectTypeOf(createAdapter(saved, options)).resolves.toExtend<ProviderAdapter>();
      expectTypeOf(createAdapter(saved, {})).resolves.toExtend<ProviderAdapter>();
      const stored: Record<string, unknown> = {};
      void createAdapter(saved, stored);
    };
    expect(typeof types).toBe("function");
  });
});

describe("REGISTRY_CREDENTIAL_KEYS", () => {
  it("covers PROVIDER_IDS exactly", () => {
    expect(Object.keys(REGISTRY_CREDENTIAL_KEYS).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(Object.keys(FACTORY_OPTION_KEYS).sort()).toEqual([...PROVIDER_IDS].sort());
  });

  for (const id of PROVIDER_IDS) {
    it(`lists the meta credential fields that are ${id} factory options`, () => {
      const options = FACTORY_OPTION_KEYS[id];
      const expected = getProviderMeta(id)
        .credentialFields.map((field) => field.name)
        .filter((name) => options.includes(name));
      expect(REGISTRY_CREDENTIAL_KEYS[id]).toEqual(expected);
    });
  }

  it("is frozen", () => {
    expect(Object.isFrozen(REGISTRY_CREDENTIAL_KEYS)).toBe(true);
    expect(Object.isFrozen(REGISTRY_CREDENTIAL_KEYS.resend)).toBe(true);
  });
});

describe("registry source", () => {
  it("has no value import of a provider module", () => {
    expect(SOURCE).toContain("createAdapter");
    // `import type` and `export type` declarations are removed by the build.
    const valueImports = [
      ...SOURCE.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm),
    ].map((match) => match[1]);
    expect(valueImports.filter((path) => path?.includes("providers"))).toEqual([]);
    expect(valueImports).toEqual([]);
  });

  it("has one dynamic import for each id, and the Cloudflare ids share one module", () => {
    const dynamic = [...SOURCE.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map(
      (match) => match[1],
    );
    expect(dynamic).toHaveLength(PROVIDER_IDS.length);
    expect([...dynamic].sort()).toEqual(
      PROVIDER_IDS.map((id) => `../providers/${moduleOf(id)}/index`).sort(),
    );
    const cloudflare = dynamic.filter((path) => path === "../providers/cloudflare/index");
    expect(cloudflare).toHaveLength(2);
  });
});

describe("registry build", () => {
  let node: NodeApis;
  let repo: string;
  let scratch: string;

  beforeAll(async () => {
    node = await loadNode();
    repo = node.toPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
    // Under the repository, so that node_modules resolves. `.tmp/` is git-ignored.
    scratch = `${repo}/.tmp/registry-${crypto.randomUUID()}`;
  });

  afterAll(() => {
    if (scratch) node.fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("emits a registry entry with no provider code in it", () => {
    // The real build config, with another outDir. No types, to keep the test fast.
    const result = node.child.spawnSync(
      node.execPath,
      [`${repo}/node_modules/tsdown/dist/run.mjs`, "--out-dir", scratch, "--no-dts"],
      { cwd: repo, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const built = node.fs.readFileSync(`${scratch}/registry/index.js`, "utf8");
    // No static import at all: the entry chunk holds only the registry.
    expect(built).not.toMatch(/^\s*import\s[^(]/m);
    expect(built).not.toMatch(/\bfrom\s*["']/);
    const dynamic = [...built.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map(
      (match) => match[1],
    );
    expect([...new Set(dynamic)].sort()).toEqual(
      [...new Set(PROVIDER_IDS.map((id) => `../providers/${moduleOf(id)}/index.js`))].sort(),
    );
    // Markers of adapter code: API hosts, the payload builders, and the provider kit.
    for (const marker of ["api.resend.com", "api.postmarkapp.com", "defineProvider", "fetch("]) {
      expect(built).not.toContain(marker);
    }
  }, 60_000);
});
