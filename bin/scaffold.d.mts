// Types of bin/scaffold.mjs, for tests and tools that import the scaffold functions.

/** The rule for a provider id. */
export declare const ID_PATTERN: RegExp;

/** The name forms of an id. For `my-mail`: My Mail, myMail, MyMail, MY_MAIL. */
export declare function names(id: string): {
  id: string;
  Name: string;
  camel: string;
  Pascal: string;
  CONST: string;
};

/** Returns null for a valid id, or the reason it is refused. */
export declare function checkId(id: string): string | null;

/** One rendered file: its path relative to the target root, and its content. */
export interface RenderedFile {
  path: string;
  content: string;
}

/**
 * Renders the four files of a new provider. `repo` uses relative source paths of the
 * mailswitch repository. `out` uses the public subpaths of the package.
 */
export declare function renderProvider(id: string, mode: "repo" | "out"): RenderedFile[];

/** Options of `main`. */
export interface MainOptions {
  cwd?: string;
  log?: (text: string) => void;
  error?: (text: string) => void;
}

/** Runs the command and returns the exit code: 0 when the files are written, else 1. */
export declare function main(args: readonly string[], options?: MainOptions): number;
