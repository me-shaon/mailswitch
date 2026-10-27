import { defineConfig, type UserConfig } from "tsdown";

// One entry per subpath export in package.json. The output paths in dist match the
// "exports" map, so each subpath gets its own .js and .d.ts file.
const config: UserConfig = defineConfig({
  entry: {
    index: "src/index.ts",
    "catalog/index": "src/catalog/index.ts",
    "provider-kit/index": "src/provider-kit/index.ts",
    "webhooks/index": "src/webhooks/index.ts",
    "crypto/index": "src/crypto/index.ts",
    "testing/index": "src/testing/index.ts",
    "conformance/index": "src/conformance/index.ts",
    "conformance/vitest": "src/conformance/vitest.ts",
    "providers/resend/index": "src/providers/resend/index.ts",
    "providers/tosend/index": "src/providers/tosend/index.ts",
    "providers/cloudflare/index": "src/providers/cloudflare/index.ts",
    "providers/mailgun/index": "src/providers/mailgun/index.ts",
    "providers/postmark/index": "src/providers/postmark/index.ts",
    "providers/brevo/index": "src/providers/brevo/index.ts",
    "providers/mailersend/index": "src/providers/mailersend/index.ts",
    "providers/mailjet/index": "src/providers/mailjet/index.ts",
    "providers/smtp2go/index": "src/providers/smtp2go/index.ts",
    "providers/zeptomail/index": "src/providers/zeptomail/index.ts",
    "providers/sendgrid/index": "src/providers/sendgrid/index.ts",
    "providers/mailchannels/index": "src/providers/mailchannels/index.ts",
    "providers/ses/index": "src/providers/ses/index.ts",
    "providers/smtp/index": "src/providers/smtp/index.ts",
    "providers/smtp/brevo": "src/providers/smtp/brevo-webhooks.ts",
    "stores/memory": "src/stores/memory.ts",
    "stores/d1": "src/stores/d1.ts",
    "stores/durable-object": "src/stores/durable-object.ts",
  },
  format: "esm",
  platform: "neutral",
  target: "es2023",
  dts: true,
  sourcemap: false,
  clean: true,
  // The D1 schema ships as a plain SQL file, so a migration can copy it from node_modules.
  // A function, so a build with another outDir (the schema test) copies it there too.
  copy: (resolved) => [{ from: "src/stores/d1-schema.sql", to: `${resolved.outDir}/stores` }],
  // vitest is an optional peer dependency of mailswitch/conformance/vitest. Keep it external.
  deps: { neverBundle: ["vitest"] },
});

export default config;
