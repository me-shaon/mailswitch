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
  // vitest is an optional peer dependency of mailswitch/conformance/vitest. Keep it external.
  deps: { neverBundle: ["vitest"] },
});

export default config;
