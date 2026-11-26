// Backup: every D1 table as JSON plus the list of R2 keys the database points to; optionally the
// R2 files themselves. `wrangler d1 export` cannot export databases with FTS5 tables, hence this.
// For "undo the last few days" use D1 Time Travel instead (7 days on the free plan):
//   pnpm exec wrangler d1 time-travel info quadmail
//
// Usage: node scripts/backup.ts --remote|--local [--with-mail]
// Output: backups/<target>-<timestamp>/ (gitignored). It contains password hashes and mail metadata:
// keep it private.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, wrangler, wranglerOutput } from "./lib.ts";

const target = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
if (!target) {
  console.error("Usage: node scripts/backup.ts --remote|--local [--with-mail]");
  process.exit(1);
}
const withMail = process.argv.includes("--with-mail");

// sessions and login_attempts are short-lived and not worth restoring; messages_fts is rebuilt from messages.
const TABLES = [
  "users",
  "identities",
  "domains",
  "threads",
  "messages",
  "attachments",
  "labels",
  "message_labels",
  "blocked_senders",
  "suppressions",
  "send_counters",
  "audit_log",
  "job_state",
];
const PAGE = 500;

function query(sql: string): Record<string, unknown>[] {
  const out = wranglerOutput(["d1", "execute", "quadmail", target!, "--json", "--command", `"${sql}"`]);
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as Array<{ results: Record<string, unknown>[] }>;
  return parsed[0]?.results ?? [];
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(ROOT, "backups", `${target.slice(2)}-${stamp}`);
mkdirSync(dir, { recursive: true });

const counts: Record<string, number> = {};
for (const table of TABLES) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    // Table names come from the fixed list above, never from input.
    const page = query(`SELECT * FROM ${table} ORDER BY rowid LIMIT ${PAGE} OFFSET ${offset}`);
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  writeFileSync(join(dir, `${table}.json`), JSON.stringify(rows, null, 1));
  counts[table] = rows.length;
  console.log(`${table}: ${rows.length} rows`);
}

const keyRows = [
  ...query("SELECT raw_key AS k FROM messages WHERE raw_key IS NOT NULL"),
  ...query("SELECT html_key AS k FROM messages WHERE html_key IS NOT NULL"),
  ...query("SELECT r2_key AS k FROM attachments"),
];
const keys = [...new Set(keyRows.map((r) => String(r.k)))].sort();
writeFileSync(join(dir, "r2-keys.txt"), keys.join("\n") + "\n");
console.log(`R2 keys listed: ${keys.length}`);

if (withMail) {
  let done = 0;
  for (const key of keys) {
    // Keys are written by the Worker (raw/yyyy/mm/<ulid>.eml, att/..., out/...): safe as paths.
    if (!/^[A-Za-z0-9/_.-]+$/.test(key)) {
      console.warn(`skipped unusual key: ${key}`);
      continue;
    }
    const file = join(dir, "r2", key);
    mkdirSync(dirname(file), { recursive: true });
    wrangler(["r2", "object", "get", `quadmail-mail/${key}`, "--file", `"${file}"`, target]);
    if (++done % 25 === 0) console.log(`downloaded ${done}/${keys.length}`);
  }
  console.log(`Downloaded ${done} files`);
}

writeFileSync(join(dir, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), target, withMail, counts, r2Keys: keys.length }, null, 1));
console.log(`Backup written to ${dir}`);
