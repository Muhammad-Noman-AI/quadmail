// Helpers shared by the Node scripts. Run with Node 22.18+ (TypeScript type stripping).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");

/** Read a value from the "vars" block of wrangler.jsonc (simple regex: the file is ours). */
export function wranglerVar(name: string): string {
  const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(text);
  if (!match?.[1]) throw new Error(`${name} not found in wrangler.jsonc`);
  return match[1];
}

export function sql(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

export function wrangler(args: string[]): void {
  // One command string through the shell so Windows finds pnpm.cmd. Every argument is built by these
  // scripts (fixed names and quoted temp paths), never user input.
  const result = spawnSync(["pnpm", "-s", "wrangler", ...args].join(" "), { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], shell: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`wrangler ${args[0]} ${args[1] ?? ""} failed:\n${result.stderr}`);
}

/** Run SQL from a temporary file (multi-statement files work on Windows; multi-line --command does not). */
export function executeSql(statements: string[], target: "--local" | "--remote"): void {
  const dir = mkdtempSync(join(tmpdir(), "quadmail-"));
  const file = join(dir, "run.sql");
  try {
    writeFileSync(file, statements.join("\n"), { mode: 0o600 });
    wrangler(["d1", "execute", "quadmail", target, "--file", `"${file}"`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function putObject(key: string, content: string, target: "--local" | "--remote"): void {
  const dir = mkdtempSync(join(tmpdir(), "quadmail-"));
  const file = join(dir, "object");
  try {
    writeFileSync(file, content);
    wrangler(["r2", "object", "put", `quadmail-mail/${key}`, "--file", `"${file}"`, target]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
