// Helpers for the API end-to-end suites. They talk to a running local dev server (`pnpm dev`) and use
// its Local Explorer API for setup and cleanup. Local data only: nothing here sends real mail.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { derivePasswordKey } from "../../src/web/auth/kdf.ts";

export const BASE = process.env.QM_BASE ?? "http://localhost:5173";
const DB_ID = "69b58cdf-eb43-4b1e-a83d-ef2be3433f70";
export const ADMIN_EMAIL = process.env.QM_ADMIN_EMAIL ?? "noman@quadgentics.com";

export function adminPassword() {
  const file = process.env.QM_ADMIN_PASSWORD_FILE;
  if (!file) throw new Error("Set QM_ADMIN_PASSWORD_FILE to a file holding the local admin password");
  return readFileSync(file, "utf8").trim();
}

let failures = 0;
export function check(label, condition, extra = "") {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${extra ? ` ${extra}` : ""}`);
}
export const failed = () => failures;

/** Run SQL on the dev server's own D1 (a second wrangler process on the same files resets the runtime). */
export async function sql(query) {
  const response = await fetch(`${BASE}/cdn-cgi/local/explorer/api/d1/database/${DB_ID}/raw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: query }),
  });
  const result = (await response.json()).result?.[0]?.results;
  return result?.columns ? result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]]))) : (result ?? []);
}

export async function runCron() {
  // The dev server's own scheduled route. (The Local Explorer's scheduled dispatch used the generic
  // top-level bindings under `vite --mode quadgentics`, so it saw an empty database.)
  const response = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("17 3 * * *")}`);
  return response.ok;
}

export async function login(email, password, totp) {
  const passwordKey = await derivePasswordKey(email, password);
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, passwordKey, ...(totp ? { totp } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, origin: BASE, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { status: response.status, data, cookie, call };
}

/** Deliver a mail through the local Email Routing handler. */
export async function deliver(to, subject, extraHeaders = "") {
  const raw = `From: Friend <friend@gmail.com>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@gmail.com>\r\nDate: ${new Date().toUTCString()}\r\n${extraHeaders}Content-Type: text/plain\r\n\r\nHello ${subject}\r\n`;
  const response = await fetch(`${BASE}/cdn-cgi/handler/email?from=friend@gmail.com&to=${encodeURIComponent(to)}`, { method: "POST", body: raw });
  return response.status;
}

/** POST a Svix-signed Resend webhook. */
export async function webhook(secret, event, { tamper = false, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(event);
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  const response = await fetch(`${BASE}/api/webhooks/resend`, {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${tamper ? `AAAA${signature.slice(4)}` : signature}` },
    body,
  });
  return response.status;
}

export const tag = () => `e2e${Date.now().toString(36)}`;
export { derivePasswordKey };
