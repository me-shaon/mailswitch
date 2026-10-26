// The few Node APIs that the scaffold test uses. The repository has no @types/node, so
// this file loads the modules at run time and gives them small local types.

export interface NodeFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  symlinkSync(target: string, path: string): void;
  writeFileSync(path: string, data: string): void;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface NodeChildProcess {
  spawnSync(
    command: string,
    args: readonly string[],
    options: { cwd?: string; encoding: "utf8"; timeout?: number },
  ): SpawnResult;
}

export interface NodeApis {
  fs: NodeFs;
  child: NodeChildProcess;
  /** The path of the running Node binary. */
  execPath: string;
  /** Converts a file URL to a path. */
  toPath(url: URL): string;
}

async function load<T>(name: string): Promise<T> {
  return (await import(/* @vite-ignore */ name)) as T;
}

/** Loads the Node APIs. Call it only in the Node test project. */
export async function loadNode(): Promise<NodeApis> {
  const fs = await load<NodeFs>("node:fs");
  const child = await load<NodeChildProcess>("node:child_process");
  const url = await load<{ fileURLToPath(url: URL): string }>("node:url");
  const proc = (globalThis as unknown as { process: { execPath: string } }).process;
  return { fs, child, execPath: proc.execPath, toPath: (value) => url.fileURLToPath(value) };
}
