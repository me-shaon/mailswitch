import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkId, main, names, renderProvider } from "../../bin/scaffold.mjs";
import { runChecks } from "../../src/conformance/index";
import type { ConformanceFixture } from "../../src/conformance/types";
import type { ProviderAdapter } from "../../src/core/adapter";
import { loadNode, type NodeApis } from "./node";

declare global {
  interface ImportMeta {
    url: string;
  }
}

// The checks that the scaffold stub fails. Each one calls send and needs a real send.
const SEND_CHECKS = [
  "attachments",
  "declaration.tier",
  "send.auth",
  "send.headers",
  "send.invalid",
  "send.ok",
  "send.rate-limited",
  "send.uncertain",
];

const ID = "acme-mail";

let node: NodeApis;
let repo: string;
let scratch: string;

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function importsOf(text: string): string[] {
  return [...text.matchAll(/from "([^"]+)";/g)].map((match) => match[1] as string);
}

function write(root: string, files: { path: string; content: string }[]): void {
  for (const file of files) {
    const target = join(root, file.path);
    node.fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    node.fs.writeFileSync(target, file.content);
  }
}

/** Links every entry of `from` into `to`, except the names in `skip`. */
function linkAll(from: string, to: string, skip: string[]): void {
  node.fs.mkdirSync(to, { recursive: true });
  for (const name of node.fs.readdirSync(from)) {
    if (!skip.includes(name)) node.fs.symlinkSync(join(from, name), join(to, name));
  }
}

function tsc(project: string) {
  return node.child.spawnSync(
    node.execPath,
    [join(repo, "node_modules/typescript/bin/tsc"), "-p", project],
    { cwd: repo, encoding: "utf8", timeout: 120_000 },
  );
}

function bin(args: string[], cwd: string = repo) {
  return node.child.spawnSync(node.execPath, [join(repo, "bin/scaffold.mjs"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

beforeAll(async () => {
  node = await loadNode();
  repo = node.toPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  // Under the repository, so that node_modules resolves. `.tmp/` is git-ignored.
  scratch = join(repo, ".tmp", `scaffold-${crypto.randomUUID()}`);
  node.fs.mkdirSync(scratch, { recursive: true });
});

afterAll(() => {
  if (scratch) node.fs.rmSync(scratch, { recursive: true, force: true });
});

describe("id rules", () => {
  it("accepts a lowercase id and builds its name forms", () => {
    expect(checkId("lettermill")).toBeNull();
    expect(checkId("acme-mail2")).toBeNull();
    expect(names("acme-mail")).toEqual({
      id: "acme-mail",
      Name: "Acme Mail",
      camel: "acmeMail",
      Pascal: "AcmeMail",
      CONST: "ACME_MAIL",
    });
  });

  it("refuses invalid ids", () => {
    for (const id of ["", "a", "Acme", "acme_mail", "1acme", "acme-", "ac--me", "a".repeat(33)]) {
      expect(checkId(id), id).not.toBeNull();
    }
    expect(checkId("delete")).toMatch(/reserved word/);
    expect(() => renderProvider("Bad Id", "repo")).toThrow(TypeError);
  });
});

describe("renderProvider", () => {
  it("writes the repository layout with relative source imports", () => {
    const files = renderProvider(ID, "repo");
    expect(files.map((file) => file.path)).toEqual([
      `src/providers/${ID}/meta.ts`,
      `src/providers/${ID}/index.ts`,
      `src/conformance/fixtures/${ID}.ts`,
      `test/providers/${ID}.conformance.test.ts`,
    ]);
    for (const file of files) {
      expect(file.content).not.toMatch(/\{\{/);
      for (const source of importsOf(file.content)) expect(source).toMatch(/^\.\.?\//);
    }
    // The catalog imports meta.ts, so it may import only core data modules.
    expect(importsOf(files[0]?.content ?? "")).toEqual(["../../core/classify", "../../core/meta"]);
    expect(files[1]?.content).toContain("SCAFFOLD STUB");
    expect(files[1]?.content).toContain("export function acmeMail(");
    expect(files[3]?.content).toContain("{ tier: 2 }");
  });

  it("writes the out layout with imports from the package", () => {
    const files = renderProvider(ID, "out");
    expect(files.map((file) => file.path)).toEqual([
      "meta.ts",
      "index.ts",
      `${ID}.fixture.ts`,
      `${ID}.conformance.test.ts`,
    ]);
    const allowed = /^(mailswitch(\/provider-kit|\/conformance|\/conformance\/vitest)?|\.\/.+)$/;
    for (const file of files) {
      for (const source of importsOf(file.content)) expect(source).toMatch(allowed);
    }
    // Two imports of one module become one statement.
    expect(importsOf(files[0]?.content ?? "")).toEqual(["mailswitch/provider-kit"]);
    expect(importsOf(files[1]?.content ?? "")).toEqual([
      "mailswitch",
      "mailswitch/provider-kit",
      "./meta",
      "./meta",
    ]);
  });
});

describe("the scaffold output", () => {
  it("typechecks in both modes, and the stub fails only the send checks", async () => {
    // Repository mode: a copy of the repository layout whose source folders link to src/.
    const root = join(scratch, "repo");
    linkAll(join(repo, "src"), join(root, "src"), ["providers", "conformance"]);
    linkAll(join(repo, "src/conformance"), join(root, "src/conformance"), ["fixtures"]);
    write(root, renderProvider(ID, "repo"));
    node.fs.writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        extends: join(repo, "tsconfig.json"),
        include: [`src/providers/${ID}`, `src/conformance/fixtures/${ID}.ts`, "test/providers"],
      }),
    );

    // Out mode: the package subpaths map to the sources.
    const out = join(scratch, "out");
    write(out, renderProvider(ID, "out"));
    const src = (path: string) => [join(repo, "src", path)];
    node.fs.writeFileSync(
      join(out, "tsconfig.json"),
      JSON.stringify({
        extends: join(repo, "tsconfig.json"),
        compilerOptions: {
          paths: {
            mailswitch: src("index.ts"),
            "mailswitch/provider-kit": src("provider-kit/index.ts"),
            "mailswitch/conformance": src("conformance/index.ts"),
            "mailswitch/conformance/vitest": src("conformance/vitest.ts"),
          },
        },
        include: ["*.ts"],
      }),
    );

    for (const project of [root, out]) {
      const result = tsc(join(project, "tsconfig.json"));
      expect(`${result.stdout}${result.stderr}`, project).toBe("");
      expect(result.status, project).toBe(0);
    }

    const adapterModule = (await import(
      /* @vite-ignore */ join(root, `src/providers/${ID}/index.ts`)
    )) as { acmeMail(): ProviderAdapter };
    const fixtureModule = (await import(
      /* @vite-ignore */ join(root, `src/conformance/fixtures/${ID}.ts`)
    )) as { acmeMailFixture(): ConformanceFixture };
    const report = await runChecks({
      adapter: adapterModule.acmeMail(),
      fixture: fixtureModule.acmeMailFixture(),
      tier: 2,
    });
    const failed = report.checks.filter((entry) => entry.status === "fail");
    expect(failed.map((entry) => entry.id).sort()).toEqual(SEND_CHECKS);
    expect(report.checks.find((entry) => entry.id === "declaration")?.status).toBe("pass");
    expect(report.checks.find((entry) => entry.id === "verify.ok")?.status).toBe("pass");
    expect(report.checks.find((entry) => entry.id === "redaction")?.status).toBe("pass");
  }, 120_000);
});

describe("the command", () => {
  it("prints the usage and exits 1 without an id", () => {
    const result = bin([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: mailswitch-scaffold <id> [--out <dir>]");
  });

  it("exits 1 for an invalid id, an unknown option, and a missing --out value", () => {
    expect(bin(["Bad_Id"]).status).toBe(1);
    expect(bin(["acme", "--force"]).status).toBe(1);
    expect(bin(["acme", "--out"]).status).toBe(1);
    expect(bin(["acme", "extra"]).status).toBe(1);
  });

  it("refuses an id that exists in the repository", () => {
    const result = bin(["resend"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The provider "resend" exists.');
  });

  it("refuses repository mode outside the repository", () => {
    const dir = join(scratch, "elsewhere");
    node.fs.mkdirSync(dir, { recursive: true });
    const result = bin(["acme"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not the mailswitch repository");
  });

  it("writes into --out, then refuses to write over the files", () => {
    const dir = join(scratch, "cli-out");
    const first = bin(["acme", "--out", dir]);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    for (const name of ["meta.ts", "index.ts", "acme.fixture.ts", "acme.conformance.test.ts"]) {
      expect(node.fs.existsSync(join(dir, name)), name).toBe(true);
    }
    const before = node.fs.readFileSync(join(dir, "meta.ts"), "utf8");
    node.fs.writeFileSync(join(dir, "meta.ts"), "// mine\n");
    const second = bin(["acme", "--out", dir]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("nothing was written");
    expect(node.fs.readFileSync(join(dir, "meta.ts"), "utf8")).toBe("// mine\n");
    expect(before).toContain('id: "acme"');
  });

  it("runs in process with injected output", () => {
    const lines: string[] = [];
    const code = main(["--help"], { log: (text) => lines.push(text), error: () => {} });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("--out <dir>");
  });
});
