// Compiles every `ts` code block of the README and the user guides. Each block becomes one
// module in a scratch project that extends tsconfig.examples.json, so `mailswitch/*`
// imports resolve to the source files. A block must be complete: it declares its own env
// bindings and the values that it does not build.

import { afterAll, beforeAll, expect, it } from "vitest";
import { loadNode, type NodeApis } from "../scaffold/node";

declare global {
  interface ImportMeta {
    url: string;
  }
}

/** The documents whose `ts` blocks must compile. */
const DOCUMENTS = [
  "README.md",
  "docs/guides/delivery-safety.md",
  "docs/guides/plainbooks.md",
  "docs/guides/envelopen.md",
  "docs/providers/resend.md",
  "docs/providers/tosend.md",
  "docs/providers/postmark.md",
  "docs/providers/sendgrid.md",
  "docs/providers/ses.md",
  "docs/providers/mailgun.md",
  "docs/providers/cloudflare.md",
  "docs/providers/smtp.md",
];

let node: NodeApis;
let repo: string;
let scratch: string;

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/**
 * The body of every fenced block with the `ts` or `typescript` info string. A block in a
 * list item is indented. The indent of its opening fence is removed from each line.
 */
function tsBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = /^( *)```(?:ts|typescript)[ \t]*\n([\s\S]*?)^\1```[ \t]*$/gm;
  for (const match of markdown.matchAll(fence)) {
    const indent = (match[1] as string).length;
    const lines = (match[2] as string).split("\n").map((line) => line.slice(indent));
    blocks.push(lines.join("\n"));
  }
  return blocks;
}

beforeAll(async () => {
  node = await loadNode();
  repo = node.toPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  // Under the repository, so that node_modules resolves. `.tmp/` is git-ignored.
  scratch = join(repo, ".tmp", `docs-${crypto.randomUUID()}`);
  node.fs.mkdirSync(scratch, { recursive: true });
});

afterAll(() => {
  if (scratch) node.fs.rmSync(scratch, { recursive: true, force: true });
});

it("finds the ts blocks of a markdown text, also in list items", () => {
  const text = [
    "a",
    "```ts",
    "const x = 1;",
    "```",
    "```sh",
    "ls",
    "```",
    "1. Step:",
    "",
    "   ```typescript",
    "   let y;",
    "   ```",
    "",
  ].join("\n");
  expect(tsBlocks(text)).toEqual(["const x = 1;\n", "let y;\n"]);
});

it("compiles every ts block of the README and the guides", () => {
  let count = 0;
  for (const document of DOCUMENTS) {
    const blocks = tsBlocks(node.fs.readFileSync(join(repo, document), "utf8"));
    expect(blocks.length, document).toBeGreaterThan(0);
    const slug = document.replace(/\.md$/, "").replace(/[^A-Za-z0-9]+/g, "-");
    blocks.forEach((block, index) => {
      // `export {}` makes each block a module, so top-level await and names stay local.
      node.fs.writeFileSync(join(scratch, `${slug}-${index + 1}.ts`), `${block}\nexport {};\n`);
      count++;
    });
  }
  expect(count).toBeGreaterThanOrEqual(DOCUMENTS.length + 2);
  node.fs.writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({ extends: join(repo, "tsconfig.examples.json"), include: ["*.ts"] }),
  );
  const result = node.child.spawnSync(
    node.execPath,
    [join(repo, "node_modules/typescript/bin/tsc"), "-p", join(scratch, "tsconfig.json")],
    { cwd: repo, encoding: "utf8", timeout: 120_000 },
  );
  expect(result.stdout + result.stderr).toBe("");
  expect(result.status).toBe(0);
}, 120_000);
