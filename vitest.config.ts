import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, type ViteUserConfig } from "vitest/config";

// Two projects. Files under test/workers/ run in workerd with @cloudflare/vitest-plugin.
// Every other test/**/*.test.ts file runs in Node. No test calls a real provider.
// The Workers project sets no compatibility flags, so core code cannot rely on nodejs_compat.
const config: ViteUserConfig = defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/workers/**"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            // The main module exports the Durable Object classes that the bindings use.
            main: "./test/workers/fixtures/do-worker.ts",
            miniflare: {
              compatibilityDate: "2026-10-01",
              d1Databases: ["DB"],
              durableObjects: {
                LIMITER: { className: "MailswitchLimiter", useSQLite: true },
                IDEMPOTENCY: { className: "MailswitchIdempotency", useSQLite: true },
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"],
        },
      },
    ],
  },
});

export default config;
