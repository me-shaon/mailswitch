import { afterAll, beforeAll, expect, it } from "vitest";
import { D1_SCHEMA } from "../../src/stores/d1";
import schemaFile from "../../src/stores/d1-schema.sql?raw";
import { loadNode, type NodeApis } from "../scaffold/node";

declare global {
  interface ImportMeta {
    url: string;
  }
}

let node: NodeApis;
let repo: string;
let scratch: string;

beforeAll(async () => {
  node = await loadNode();
  repo = node.toPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  // Under the repository, so that node_modules resolves. `.tmp/` is git-ignored.
  scratch = `${repo}/.tmp/schema-${crypto.randomUUID()}`;
});

afterAll(() => {
  if (scratch) node.fs.rmSync(scratch, { recursive: true, force: true });
});

it("keeps d1-schema.sql and D1_SCHEMA the same", () => {
  expect(schemaFile).toBe(D1_SCHEMA);
});

it("exports the schema file from the package", () => {
  const pkg = JSON.parse(node.fs.readFileSync(`${repo}/package.json`, "utf8")) as {
    exports: Record<string, unknown>;
    files: string[];
  };
  expect(pkg.exports["./stores/d1-schema.sql"]).toBe("./dist/stores/d1-schema.sql");
  expect(pkg.files).toContain("dist");
});

it("copies the schema file into the build output with the D1_SCHEMA text", () => {
  // The real build config, with another outDir. No types, to keep the test fast.
  const result = node.child.spawnSync(
    node.execPath,
    [`${repo}/node_modules/tsdown/dist/run.mjs`, "--out-dir", scratch, "--no-dts"],
    { cwd: repo, encoding: "utf8", timeout: 60_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(node.fs.readFileSync(`${scratch}/stores/d1-schema.sql`, "utf8")).toBe(D1_SCHEMA);
}, 60_000);
