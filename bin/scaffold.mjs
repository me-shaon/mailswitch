#!/usr/bin/env node
// mailswitch-scaffold: writes the files of a new provider from the templates in
// templates/provider/. It runs on Node 22 or later and has no dependencies.
//
//   mailswitch-scaffold <id>              in the mailswitch repository
//   mailswitch-scaffold <id> --out <dir>  for a custom provider in any project
//
// Exit codes: 0 when the files are written, 1 for bad arguments or a refusal.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The rule for a provider id. */
export const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

const TEMPLATE_DIR = fileURLToPath(new URL("../templates/provider/", import.meta.url));

const USAGE = `Usage: mailswitch-scaffold <id> [--out <dir>]

Writes a provider stub, a conformance fixture, and a conformance test.

  <id>         The provider id: a lowercase letter, then 1 to 31 lowercase
               letters, digits, or hyphens. For example: lettermill.
  --out <dir>  Write the four files into <dir>, with imports from the
               mailswitch package. Use it for a custom provider.

Without --out, run the command in the root of the mailswitch repository.
The files then go into src/providers/<id>/, src/conformance/fixtures/,
and test/providers/.

Read docs/guides/add-a-provider.md before you fill in the files.`;

// Words that cannot name the adapter factory function.
const RESERVED = new Set(
  (
    "await break case catch class const continue debugger default delete do else enum " +
    "export extends false finally for function if implements import in instanceof " +
    "interface let new null package private protected public return static super switch " +
    "this throw true try typeof var void while with yield"
  ).split(" "),
);

/** The four templates, with the logical name of each file. */
const FILES = [
  { key: "meta", template: "meta.ts.tmpl" },
  { key: "index", template: "index.ts.tmpl" },
  { key: "fixture", template: "fixture.ts.tmpl" },
  { key: "test", template: "test.ts.tmpl" },
];

/** The path of each file, relative to the target root. */
function paths(id, mode) {
  if (mode === "repo") {
    return {
      meta: `src/providers/${id}/meta.ts`,
      index: `src/providers/${id}/index.ts`,
      fixture: `src/conformance/fixtures/${id}.ts`,
      test: `test/providers/${id}.conformance.test.ts`,
    };
  }
  return {
    meta: "meta.ts",
    index: "index.ts",
    fixture: `${id}.fixture.ts`,
    test: `${id}.conformance.test.ts`,
  };
}

/**
 * The module specifier of each logical import, per file. Repository mode uses relative
 * source paths. The meta file imports only core data modules, so a catalog stays free of
 * adapter code. Out mode uses the public subpaths of the package.
 */
function specifiers(id, mode, file) {
  if (mode === "out") {
    return {
      kit: "mailswitch/provider-kit",
      "kit:meta": "mailswitch/provider-kit",
      "kit:classify": "mailswitch/provider-kit",
      "core:message": "mailswitch",
      "core:types": "mailswitch",
      conformance: "mailswitch/conformance",
      "conformance:vitest": "mailswitch/conformance/vitest",
      adapter: "./index",
      meta: "./meta",
      fixture: `./${id}.fixture`,
    };
  }
  const table = {
    meta: { "kit:meta": "../../core/meta", "kit:classify": "../../core/classify" },
    index: {
      kit: "../../provider-kit/index",
      "core:message": "../../core/message",
      "core:types": "../../core/types",
      meta: "./meta",
    },
    fixture: { conformance: "../types", adapter: `../../providers/${id}/index` },
    test: {
      "conformance:vitest": "../../src/conformance/vitest",
      adapter: `../../src/providers/${id}/index`,
      fixture: `../../src/conformance/fixtures/${id}`,
    },
  };
  return table[file];
}

/** The name forms of an id. For `my-mail`: My Mail, myMail, MyMail, MY_MAIL. */
export function names(id) {
  const parts = id.split("-").filter((part) => part !== "");
  const cap = (part) => part.charAt(0).toUpperCase() + part.slice(1);
  return {
    id,
    Name: parts.map(cap).join(" "),
    camel: parts.map((part, i) => (i === 0 ? part : cap(part))).join(""),
    Pascal: parts.map(cap).join(""),
    CONST: parts.map((part) => part.toUpperCase()).join("_"),
  };
}

/**
 * Checks a provider id. Returns null for a valid id, or the reason it is refused.
 */
export function checkId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return `The id "${String(id)}" is not valid. Use a lowercase letter, then 1 to 31 lowercase letters, digits, or hyphens.`;
  }
  if (id.endsWith("-") || id.includes("--")) {
    return `The id "${id}" is not valid. Do not end it with a hyphen or use two hyphens together.`;
  }
  if (RESERVED.has(names(id).camel)) {
    return `The id "${id}" is a JavaScript reserved word. Choose another id.`;
  }
  return null;
}

// Biome order for named imports: letters compare without case, and an uppercase letter
// comes before the same lowercase letter.
function compareNames(a, b) {
  const x = a.replace(/^type /, "");
  const y = b.replace(/^type /, "");
  const length = Math.min(x.length, y.length);
  for (let i = 0; i < length; i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    const lp = p.toLowerCase();
    const lq = q.toLowerCase();
    if (lp !== lq) return lp < lq ? -1 : 1;
    return p === p.toUpperCase() ? -1 : 1;
  }
  return x.length - y.length;
}

// Packages first, then relative paths from the farthest to the nearest.
function compareSources(a, b) {
  const rank = (source) => {
    if (!source.startsWith(".")) return 0;
    return 100 - source.split("../").length;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

const IMPORT_LINE = /^import (type )?\{([^}]*)\} from "([^"]+)";$/;

function formatImport(typeOnly, list, source) {
  const head = typeOnly ? "import type" : "import";
  const line = `${head} { ${list.join(", ")} } from "${source}";`;
  if (line.length <= 100) return line;
  return `${head} {\n${list.map((name) => `  ${name},`).join("\n")}\n} from "${source}";`;
}

/**
 * Merges the import statements at the top of a rendered file. Two imports of the same
 * module become one, and the statements are sorted the way Biome sorts them.
 */
function organizeImports(text) {
  const lines = text.split("\n");
  // Collapse multi-line imports to one line first.
  const flat = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^import (type )?\{$/.test(line)) {
      while (i + 1 < lines.length && !line.includes("} from ")) {
        i += 1;
        line += ` ${lines[i].trim()}`;
      }
      line = line.replace(/\{\s+/, "{ ").replace(/,?\s*\}/, " }");
    }
    flat.push(line);
  }
  const start = flat.findIndex((line) => IMPORT_LINE.test(line));
  if (start === -1) return text;
  let end = start;
  while (end < flat.length && (IMPORT_LINE.test(flat[end]) || flat[end] === "")) end += 1;
  while (end > start && flat[end - 1] === "") end -= 1;
  const bySource = new Map();
  for (const line of flat.slice(start, end)) {
    const match = IMPORT_LINE.exec(line);
    if (!match) continue;
    const source = match[3];
    const entry = bySource.get(source) ?? { values: false, list: [] };
    for (const raw of match[2].split(",")) {
      const name = raw.trim();
      if (name === "") continue;
      const typed = match[1] ? `type ${name.replace(/^type /, "")}` : name;
      if (!typed.startsWith("type ")) entry.values = true;
      if (!entry.list.includes(typed)) entry.list.push(typed);
    }
    bySource.set(source, entry);
  }
  const statements = [...bySource.keys()].sort(compareSources).map((source) => {
    const entry = bySource.get(source);
    const list = [...entry.list].sort(compareNames);
    if (!entry.values) {
      return formatImport(
        true,
        list.map((name) => name.replace(/^type /, "")),
        source,
      );
    }
    return formatImport(false, list, source);
  });
  return [...flat.slice(0, start), ...statements, ...flat.slice(end)].join("\n");
}

function render(template, values, imports) {
  return template
    .replace(/\{\{import:([a-z:-]+)\}\}/g, (_, key) => {
      const source = imports[key];
      if (source === undefined) throw new Error(`The template uses an unknown import: ${key}.`);
      return source;
    })
    .replace(/\{\{([A-Za-z]+)\}\}/g, (_, key) => {
      const value = values[key];
      if (value === undefined) throw new Error(`The template uses an unknown placeholder: ${key}.`);
      return value;
    });
}

/**
 * Renders the four files of a new provider. Returns their paths, relative to the target
 * root, and their contents. It reads the templates and writes nothing.
 *
 * @param {string} id The provider id.
 * @param {"repo" | "out"} mode `repo` for the mailswitch repository, `out` for a custom provider.
 * @throws TypeError for an invalid id or mode.
 */
export function renderProvider(id, mode) {
  const problem = checkId(id);
  if (problem) throw new TypeError(problem);
  if (mode !== "repo" && mode !== "out") throw new TypeError('mode must be "repo" or "out".');
  const values = names(id);
  const where = paths(id, mode);
  return FILES.map(({ key, template }) => {
    const text = readFileSync(join(TEMPLATE_DIR, template), "utf8");
    return {
      path: where[key],
      content: organizeImports(render(text, values, specifiers(id, mode, key))),
    };
  });
}

function isMailswitchRepo(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg.name === "mailswitch" && existsSync(join(dir, "src", "providers"));
  } catch {
    return false;
  }
}

function parseArgs(args) {
  let id;
  let out;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-"))
        return { error: "--out needs a directory." };
      if (out !== undefined) return { error: "Give --out once." };
      out = value;
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else if (arg.startsWith("-")) {
      return { error: `The option ${arg} is not known.` };
    } else if (id === undefined) {
      id = arg;
    } else {
      return { error: "Give one provider id." };
    }
  }
  if (id === undefined) return { error: "Give a provider id." };
  return { id, out };
}

/**
 * Runs the command. Returns the exit code. `cwd` is the directory that the command runs
 * in. `log` and `error` print one message each.
 */
export function main(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((text) => console.log(text));
  const error = options.error ?? ((text) => console.error(text));

  const parsed = parseArgs(args);
  if (parsed.help) {
    log(USAGE);
    return 0;
  }
  if (parsed.error) {
    error(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const problem = checkId(parsed.id);
  if (problem) {
    error(problem);
    return 1;
  }
  const mode = parsed.out === undefined ? "repo" : "out";
  const root = mode === "out" ? resolve(cwd, parsed.out) : cwd;
  if (mode === "repo") {
    if (!isMailswitchRepo(root)) {
      error(
        `This directory is not the mailswitch repository. Run the command in its root, or pass --out <dir>.\n\n${USAGE}`,
      );
      return 1;
    }
    if (existsSync(join(root, "src", "providers", parsed.id))) {
      error(`The provider "${parsed.id}" exists. Choose another id.`);
      return 1;
    }
  }
  const files = renderProvider(parsed.id, mode);
  const taken = files.filter((file) => existsSync(join(root, file.path)));
  if (taken.length > 0) {
    error(
      `These files exist, so nothing was written:\n${taken.map((file) => `  ${file.path}`).join("\n")}`,
    );
    return 1;
  }
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, { flag: "wx" });
  }
  const test = files.find((file) => file.path.endsWith(".conformance.test.ts"));
  log(
    [
      `Wrote the ${parsed.id} provider:`,
      ...files.map((file) => `  ${join(mode === "out" ? parsed.out : ".", file.path)}`),
      "",
      "Next steps:",
      "  1. Fill in every TODO(scaffold) and replace the SCAFFOLD STUB in send.",
      `  2. Run the conformance test: vitest run ${test ? join(mode === "out" ? parsed.out : ".", test.path) : ""}`,
      "  3. Follow the checklist in docs/guides/add-a-provider.md.",
    ].join("\n"),
  );
  return 0;
}

function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntry()) process.exitCode = main(process.argv.slice(2));
