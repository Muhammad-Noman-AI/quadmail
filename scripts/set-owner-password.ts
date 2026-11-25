// Set (or reset) the owner's password. Signs out every existing session.
//   pnpm owner:password            -> local D1 (Miniflare)
//   pnpm owner:password --remote   -> Cloudflare D1
// The password is read from the terminal (hidden) or from stdin, never from arguments.
import { createInterface } from "node:readline";
import { derivePasswordKey } from "../src/web/auth/kdf.ts";
import { hashPasswordKey } from "../src/worker/auth/password.ts";
import { ulid } from "../src/shared/ulid.ts";
import { executeSql, sql, wranglerVar } from "./lib.ts";

const MIN_LENGTH = 12;

async function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const lines = createInterface({ input: stdin });
    for await (const line of lines) return line;
    return "";
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const target = process.argv.includes("--remote") ? "--remote" : "--local";
  const email = wranglerVar("OWNER_EMAIL").toLowerCase();
  const password = await readHidden(`New password for ${email}: `);
  if (password.length < MIN_LENGTH) throw new Error(`Use at least ${MIN_LENGTH} characters.`);
  if (process.stdin.isTTY && (await readHidden("Repeat password: ")) !== password) throw new Error("Passwords do not match.");

  process.stdout.write("Deriving key (600,000 PBKDF2 iterations)...\n");
  const hash = await hashPasswordKey(await derivePasswordKey(email, password));
  const now = Date.now();
  executeSql(
    [
      `INSERT INTO users (id, email, password_hash, created_at) VALUES (${sql(ulid())}, ${sql(email)}, ${sql(hash)}, ${now}) ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash;`,
      `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${sql(email)});`,
      `INSERT INTO audit_log (id, at, actor, action, detail_json) VALUES (${sql(ulid())}, ${now}, 'script', 'password.set', ${sql(JSON.stringify({ email }))});`,
    ],
    target,
  );
  process.stdout.write(`Password set for ${email} (${target.slice(2)} database). All sessions signed out.\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
