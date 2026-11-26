// API end-to-end suites against a running local dev server. Usage:
//   pnpm dev                                    (in another terminal)
//   QM_ADMIN_PASSWORD_FILE=/path/to/pw pnpm e2e  (optional: QM_BASE, QM_WEBHOOK_SECRET)
// Test data is removed at the end through the retention job, so R2 files go too.
import { check, failed, runCron, sql } from "./lib.mjs";
import { opsSuite } from "./ops.mjs";
import { sendSuite } from "./send.mjs";
import { teamSuite } from "./team.mjs";

const cleanups = [];
for (const [name, suite] of [
  ["team", teamSuite],
  ["send", sendSuite],
  ["ops", opsSuite],
]) {
  console.log(`\n== ${name}`);
  try {
    const cleanup = await suite();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  } catch (err) {
    check(`${name} suite crashed`, false, err instanceof Error ? err.message : String(err));
  }
}

console.log("\n== cleanup");
await runCron();
await new Promise((r) => setTimeout(r, 8000));
for (const cleanup of cleanups) await cleanup();
// The suites log in many times from one IP; clear the counters so manual use is not throttled.
await sql("DELETE FROM login_attempts");
check("cleanup: no test users left", (await sql("SELECT count(*) AS n FROM users WHERE email LIKE '%.e2e%'"))[0]?.n === 0);

console.log(failed() ? `\n${failed()} FAILED` : "\nALL PASS");
process.exit(failed() ? 1 : 0);
