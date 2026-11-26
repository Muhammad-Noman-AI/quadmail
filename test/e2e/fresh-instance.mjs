// Starts a mock Resend and a brand-new, empty QuadMail (generic config) and keeps them running, to try
// the setup wizard by hand: `pnpm build && node test/e2e/fresh-instance.mjs`, then open the printed URL.
// Setup code: e2e-setup-code-2026. Resend keys: re_full (full access), re_restricted (send only).
// Ctrl+C stops both and deletes the temporary database.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockResend } from "./mock-resend.mjs";

const ROOT = join(import.meta.dirname, "..", "..").replace(/\\/g, "/");
const APP_PORT = Number(process.env.QM_FRESH_PORT ?? 8790);
const MOCK_PORT = APP_PORT + 1;
const work = mkdtempSync(join(tmpdir(), "quadmail-fresh-")).replace(/\\/g, "/");
writeFileSync(
  `${work}/wrangler.jsonc`,
  JSON.stringify({
    name: "quadmail",
    main: `${ROOT}/src/worker/index.ts`,
    compatibility_date: "2026-11-01",
    assets: { directory: `${ROOT}/dist/client`, not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
    vars: { MAIL_PROVIDER: "resend", RESEND_API_BASE: `http://127.0.0.1:${MOCK_PORT}` },
    d1_databases: [{ binding: "DB", database_name: "quadmail", database_id: "00000000-0000-0000-0000-000000000002", migrations_dir: `${ROOT}/migrations` }],
    r2_buckets: [{ binding: "MAIL", bucket_name: "quadmail-fresh" }],
  }),
);
writeFileSync(`${work}/.dev.vars`, "SETUP_CODE=e2e-setup-code-2026\n");
const cfg = `"${work}/wrangler.jsonc"`;
const migrate = spawnSync(`pnpm -s wrangler d1 migrations apply quadmail --local --config ${cfg} --persist-to "${work}/state"`, { cwd: ROOT, shell: true, encoding: "utf8" });
if (migrate.status !== 0) throw new Error(migrate.stderr);
const mock = await startMockResend(MOCK_PORT);
const app = spawn(`pnpm -s wrangler dev --config ${cfg} --persist-to "${work}/state" --port ${APP_PORT} --ip 127.0.0.1`, { cwd: ROOT, shell: true, stdio: "ignore" });
console.log(`Fresh QuadMail: http://127.0.0.1:${APP_PORT}  (mock Resend on ${MOCK_PORT})`);
console.log(`Deliver a test mail: curl -X POST "http://127.0.0.1:${APP_PORT}/cdn-cgi/handler/email?from=a@gmail.com&to=ADDRESS" --data-binary @test/fixtures/plain.eml`);

const stop = () => {
  if (process.platform === "win32") spawnSync(`taskkill /pid ${app.pid} /T /F`, { shell: true, stdio: "ignore" });
  else app.kill();
  mock.close();
  setTimeout(() => {
    rmSync(work, { recursive: true, force: true });
    process.exit(0);
  }, 1000);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
