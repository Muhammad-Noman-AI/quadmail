// Fresh-installation e2e: starts a mock Resend and a brand-new QuadMail (empty database, generic
// config, no domain vars) and walks the whole setup wizard API. Self-contained: `pnpm e2e:setup`.
// Needs `pnpm build` first (static assets). Nothing real is contacted except DNS-over-HTTPS.
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePasswordKey } from "../../src/web/auth/kdf.ts";
import { startMockResend } from "./mock-resend.mjs";

const ROOT = join(import.meta.dirname, "..", "..").replace(/\\/g, "/");
const APP_PORT = 8790;
const MOCK_PORT = 8791;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const CODE = "e2e-setup-code-2026";
const DOMAIN = "quadmail-e2e.example";
const ADMIN = `admin@${DOMAIN}`;
const PASSWORD = "AdminPass-2026-e2e";

let failures = 0;
const check = (label, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` ${extra}` : ""}`);
};

// Generic config like the Deploy button's: no domain, owner or app URL vars.
const work = mkdtempSync(join(tmpdir(), "quadmail-setup-e2e-")).replace(/\\/g, "/");
writeFileSync(
  `${work}/wrangler.jsonc`,
  JSON.stringify({
    name: "quadmail",
    main: `${ROOT}/src/worker/index.ts`,
    compatibility_date: "2026-11-01",
    assets: { directory: `${ROOT}/dist/client`, not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
    vars: { MAIL_PROVIDER: "resend", RESEND_API_BASE: `http://127.0.0.1:${MOCK_PORT}` },
    d1_databases: [{ binding: "DB", database_name: "quadmail", database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: `${ROOT}/migrations` }],
    r2_buckets: [{ binding: "MAIL", bucket_name: "quadmail-e2e" }],
  }),
);
writeFileSync(`${work}/.dev.vars`, `SETUP_CODE=${CODE}\n`);
const wrangler = (args, options = {}) => spawnSync(["pnpm", "-s", "wrangler", ...args].join(" "), { cwd: ROOT, shell: true, encoding: "utf8", ...options });

const migrate = wrangler(["d1", "migrations", "apply", "quadmail", "--local", "--config", `"${work}/wrangler.jsonc"`, "--persist-to", `"${work}/state"`]);
if (migrate.status !== 0) throw new Error(`migrations failed: ${migrate.stderr}`);
if (!(await portFree(APP_PORT)) || !(await portFree(MOCK_PORT))) throw new Error(`Ports ${APP_PORT}/${MOCK_PORT} are busy: stop the earlier test run first.`);
const mock = await startMockResend(MOCK_PORT);
const app = spawn(["pnpm", "-s", "wrangler", "dev", "--config", `"${work}/wrangler.jsonc"`, "--persist-to", `"${work}/state"`, "--port", String(APP_PORT), "--ip", "127.0.0.1"].join(" "), {
  cwd: ROOT,
  shell: true,
  stdio: "ignore",
});

async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return false;
  } catch {
    return true;
  }
}

async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("dev server did not start");
}

function client(cookie = "") {
  const jar = { cookie };
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { origin: BASE, ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get("set-cookie");
    if (set) jar.cookie = set.split(";")[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { jar, call };
}

try {
  await waitForApp();
  const anon = client();
  let x = await anon.call("GET", "/api/setup/status");
  check("fresh installation reports fresh and a configured code", x.data.state === "fresh" && x.data.codeConfigured === true, JSON.stringify(x.data));
  const passwordKey = await derivePasswordKey(ADMIN, PASSWORD);
  const adminBody = { code: CODE, orgName: "E2E Org", domain: DOMAIN, email: ADMIN, displayName: "Admin", passwordKey };
  check("wrong setup code refused", (await anon.call("POST", "/api/setup/admin", { ...adminBody, code: "wrong-code-123" })).status === 401);
  check("admin outside the domain refused", (await anon.call("POST", "/api/setup/admin", { ...adminBody, email: "me@gmail.com" })).status === 400);
  check("steps need the admin session", (await anon.call("POST", "/api/setup/resend", { apiKey: "re_full" })).status === 401);

  const admin = client();
  x = await admin.call("POST", "/api/setup/admin", adminBody);
  check("setup code creates the organisation and admin, signed in", x.status === 201 && admin.jar.cookie.startsWith("__Host-qm_session="), String(x.status));
  check("a second claim is refused", (await client().call("POST", "/api/setup/admin", { ...adminBody, email: `two@${DOMAIN}` })).status === 409);
  check("anonymous status reveals only the state", JSON.stringify((await anon.call("GET", "/api/setup/status")).data) === JSON.stringify({ state: "in_progress", codeConfigured: true }));
  x = await admin.call("GET", "/api/setup/status");
  check("admin status: org and domain", x.data.orgName === "E2E Org" && x.data.domain === DOMAIN && !x.data.resendConnected);

  x = await admin.call("POST", "/api/setup/resend", { apiKey: "re_restricted" });
  check("a sending-only key is refused with an explanation", x.status === 400 && /Full access/.test(x.data.error), x.data?.error);
  x = await admin.call("POST", "/api/setup/resend", { apiKey: "re_full" });
  check("full key: domain added, DNS records returned", x.status === 200 && x.data.name === DOMAIN && x.data.records.length === 3, JSON.stringify({ status: x.status, n: x.data?.records?.length }));
  check("domain exists once at Resend", mock.state.domains.size === 1);
  x = await admin.call("POST", "/api/setup/resend", { apiKey: "re_full" });
  check("connecting again reuses the domain", mock.state.domains.size === 1 && x.status === 200);

  check("sending before verification refused", (await admin.call("POST", "/api/setup/sending", {})).status === 400);
  x = await admin.call("POST", "/api/setup/domain/verify");
  check("verify: Resend verified, DNS report present", x.data.domain?.status === "verified" && ["ok", "warn", "fail"].includes(x.data.dns?.mx?.status), JSON.stringify(x.data?.dns?.mx));

  x = await admin.call("POST", "/api/setup/sending", {});
  check("an existing webhook needs confirmation", x.status === 409 && x.data.needsConfirmation && x.data.existing[0] === "https://old-tool.example/hook");
  x = await admin.call("POST", "/api/setup/sending", { replaceWebhooks: true });
  check("sending ready after confirmation", x.status === 200, JSON.stringify(x.data));
  const hook = mock.state.webhooks[0];
  check("webhook replaced and points at this installation", mock.state.webhooks.length === 1 && hook.endpoint === `${BASE}/api/webhooks/resend`);
  const created = mock.state.createdKeys[0];
  check("a sending-only key for the domain was created", created?.permission === "sending_access" && created?.domain_id === [...mock.state.domains.keys()][0]);
  check("the full-access key is forgotten", (await admin.call("GET", "/api/setup/domain")).status === 410);
  x = await admin.call("GET", "/api/sending");
  check("sending reports ready, domain allowed", x.data.providerReady === true && x.data.allowedDomains[0] === DOMAIN);

  x = await admin.call("POST", "/api/setup/inbound-test");
  const testAddress = x.data.address;
  check("inbound test address on the domain", new RegExp(`^setup-[0-9a-f]{6}@${DOMAIN.replace(/\./g, "\\.")}$`).test(testAddress ?? ""), testAddress);
  check("not received yet", (await admin.call("GET", "/api/setup/inbound-test")).data.received === false);
  const raw = `From: me@gmail.com\r\nTo: ${testAddress}\r\nSubject: setup test\r\nMessage-ID: <t1@gmail.com>\r\n\r\nhi\r\n`;
  await fetch(`${BASE}/cdn-cgi/handler/email?from=me@gmail.com&to=${encodeURIComponent(testAddress)}`, { method: "POST", body: raw });
  check("inbound test mail detected", (await admin.call("GET", "/api/setup/inbound-test")).data.received === true);

  x = await admin.call("POST", "/api/setup/send-test", { to: "me@gmail.com" });
  const testMail = mock.state.emails.at(-1);
  check("send test uses the new sending key", x.status === 200 && testMail?.key === created.token && testMail.body.to[0] === "me@gmail.com", JSON.stringify(x.data));

  x = await admin.call("POST", "/api/drafts", { from: ADMIN, to: [{ address: "friend@gmail.com" }], cc: [], bcc: [], subject: "first mail", html: "<p>hi</p>", text: "hi" });
  const draftId = x.data.id;
  x = await admin.call("POST", `/api/drafts/${draftId}/send`);
  check("normal sending works with stored settings", x.status === 200 && mock.state.emails.at(-1)?.body.subject === "first mail", JSON.stringify(x.data));

  // The stored webhook secret verifies Resend's signature.
  const event = JSON.stringify({ type: "email.delivered", data: { email_id: "email-x" } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", Buffer.from(hook.secret.slice(6), "base64")).update(`msg_1.${ts}.${event}`).digest("base64");
  const wh = await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` }, body: event });
  check("webhook verified with the stored secret", wh.status === 200);

  check("finish", (await admin.call("POST", "/api/setup/finish")).status === 200);
  check("after finish: state complete", (await anon.call("GET", "/api/setup/status")).data.state === "complete");
  check("after finish: setup steps closed", (await admin.call("POST", "/api/setup/inbound-test")).status === 409);
  const relogin = client();
  const login = await relogin.call("POST", "/api/auth/login", { email: ADMIN, passwordKey });
  check("the admin signs in normally", login.status === 200 && login.data.mustChangePassword === false);

  // S4: Settings → Domains & sending.
  const second = "second-e2e.example";
  x = await admin.call("GET", "/api/admin/sending");
  check("settings: one domain, nothing fixed by env", x.data.domains.join() === DOMAIN && !x.data.domainsFromEnv && !x.data.limitFromEnv && !x.data.keyFromEnv);
  check("settings: change the daily limit", (await admin.call("PATCH", "/api/admin/sending", { dailyLimit: 50 })).status === 200 && (await admin.call("GET", "/api/sending")).data.dailyLimit === 50);
  x = await admin.call("POST", "/api/admin/domains", { domain: second, apiKey: "re_full" });
  check("settings: adding a domain returns its DNS records", x.status === 200 && x.data.name === second && x.data.records.length > 0);
  x = await admin.call("POST", "/api/admin/domains/verify");
  const allKey = mock.state.createdKeys.at(-1);
  check("settings: verified domain added with a key for all domains", x.data.added === true && allKey.domain_id === undefined && allKey.permission === "sending_access");
  check("settings: both domains listed", (await admin.call("GET", "/api/admin/sending")).data.domains.join() === `${DOMAIN},${second}`);
  const me = (await admin.call("GET", "/api/me")).data;
  check("settings: the new domain can be given as an address", (await admin.call("POST", `/api/team/${me.id}/addresses`, { address: `sales@${second}` })).status === 201);
  x = await admin.call("POST", "/api/drafts", { from: `sales@${second}`, to: [{ address: "friend@gmail.com" }], cc: [], bcc: [], subject: "from second", html: "<p>hi</p>", text: "hi" });
  x = await admin.call("POST", `/api/drafts/${x.data.id}/send`);
  check("settings: sending from the new domain uses the new key", x.status === 200 && mock.state.emails.at(-1)?.key === allKey.token);
  check("settings: remove a domain", (await admin.call("DELETE", `/api/admin/domains/${second}`)).status === 200 && (await admin.call("GET", "/api/admin/sending")).data.domains.join() === DOMAIN);
  check("settings: the last domain cannot be removed", (await admin.call("DELETE", `/api/admin/domains/${DOMAIN}`)).status === 400);
  x = await admin.call("POST", "/api/admin/resend-key", { apiKey: "re_full" });
  const replaced = mock.state.createdKeys.at(-1);
  check("settings: replace key creates a domain-restricted sending key", x.status === 200 && replaced.domain_id === [...mock.state.domains.values()].find((d) => d.name === DOMAIN)?.id);
  check("settings: a restricted key cannot manage domains", (await admin.call("POST", "/api/admin/domains", { domain: "third.example", apiKey: "re_restricted" })).status === 400);

  // Secrets are stored encrypted, never in plain text.
  const dump = wrangler(["d1", "execute", "quadmail", "--local", "--config", `"${work}/wrangler.jsonc"`, "--persist-to", `"${work}/state"`, "--json", "--command", '"SELECT key, value FROM app_config"']);
  check("no secret in plain text in D1", !dump.stdout.includes(created.token) && !dump.stdout.includes(hook.secret) && !dump.stdout.includes("re_full"));
} catch (err) {
  check("setup e2e crashed", false, err instanceof Error ? err.message : String(err));
} finally {
  // Kill the whole process tree first: killing the shell alone would orphan wrangler and workerd.
  if (process.platform === "win32") spawnSync(`taskkill /pid ${app.pid} /T /F`, { shell: true, stdio: "ignore" });
  else app.kill();
  mock.close();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
