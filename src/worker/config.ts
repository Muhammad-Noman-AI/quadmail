// Installation settings: Worker vars/secrets first, then values the setup wizard stored in D1.
//
// Secrets stored in D1 (Resend key, webhook secret) are encrypted with AES-256-GCM. The key is derived
// (HKDF) from a random master key kept in R2 at system/master.key, so a D1 export or backup alone does not
// reveal them. Losing the R2 object means re-entering the Resend key and re-enrolling 2FA, nothing more.
import { parseConfig, type AppConfig } from "../shared/env";
import { decryptString, encryptString, fromBase64, toBase64 } from "./auth/crypto";

export const DEFAULT_DAILY_LIMIT = 90;
const MASTER_KEY_OBJECT = "system/master.key";
/** Per-isolate cache. Writes in this isolate clear it; other isolates see changes within this time. */
const CACHE_MS = 30_000;

export interface ResolvedConfig {
  /** Public address of the app (for links in emails). Null until known. */
  appUrl: string | null;
  orgName: string | null;
  /** Domains users may send from. Empty until setup has chosen one. */
  allowedDomains: string[];
  dailyLimit: number;
  provider: "resend" | "cloudflare";
  resendApiKey: string | null;
  webhookSecret: string | null;
}

/** Plain values stored in app_config (secrets already decrypted). */
export interface StoredConfig {
  app_url?: string;
  org_name?: string;
  sending_domains?: string;
  daily_limit?: string;
  resend_api_key?: string;
  resend_webhook_secret?: string;
}

const SECRET_KEYS = new Set<keyof StoredConfig>(["resend_api_key", "resend_webhook_secret"]);

function domains(csv: string | undefined): string[] {
  return (csv ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** Env wins over stored values, field by field. Pure, for tests. */
export function resolveConfig(env: AppConfig, stored: StoredConfig): ResolvedConfig {
  const storedLimit = Number(stored.daily_limit);
  return {
    appUrl: env.APP_URL ?? stored.app_url ?? null,
    orgName: stored.org_name ?? null,
    allowedDomains: env.ALLOWED_SENDING_DOMAINS ?? domains(stored.sending_domains),
    dailyLimit: env.DAILY_SEND_LIMIT ?? (Number.isInteger(storedLimit) && storedLimit > 0 && storedLimit <= 100 ? storedLimit : DEFAULT_DAILY_LIMIT),
    provider: env.MAIL_PROVIDER,
    resendApiKey: env.RESEND_API_KEY ?? stored.resend_api_key ?? null,
    webhookSecret: env.RESEND_WEBHOOK_SECRET ?? stored.resend_webhook_secret ?? null,
  };
}

const encoder = new TextEncoder();

/** 32-byte subkey for one purpose, from the master key (HKDF-SHA256). */
export async function deriveKey(masterBase64: string, purpose: string): Promise<string> {
  const ikm = await crypto.subtle.importKey("raw", fromBase64(masterBase64), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(`quadmail:${purpose}`) }, ikm, 256);
  return toBase64(new Uint8Array(bits));
}

/** The master key, created on first use. A conditional write keeps two isolates from creating two keys. */
export async function masterKey(bucket: R2Bucket, create: boolean): Promise<string | null> {
  const existing = await bucket.get(MASTER_KEY_OBJECT);
  if (existing) return (await existing.text()).trim();
  if (!create) return null;
  const fresh = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const written = await bucket.put(MASTER_KEY_OBJECT, fresh, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "text/plain" } });
  if (written) return fresh;
  const winner = await bucket.get(MASTER_KEY_OBJECT);
  return winner ? (await winner.text()).trim() : null;
}

let cache: { at: number; value: ResolvedConfig } | null = null;

export function clearConfigCache(): void {
  cache = null;
}

async function readStored(env: Env): Promise<StoredConfig> {
  const { results } = await env.DB.prepare("SELECT key, value FROM app_config").all<{ key: keyof StoredConfig; value: string }>();
  const stored: StoredConfig = {};
  const secrets = results.filter((r) => SECRET_KEYS.has(r.key));
  const key = secrets.length ? await masterKey(env.MAIL, false) : null;
  const secretKey = key ? await deriveKey(key, "config") : null;
  for (const row of results) {
    if (!SECRET_KEYS.has(row.key)) stored[row.key] = row.value;
    else if (secretKey) {
      // A value that cannot be decrypted (master key replaced) counts as not set.
      stored[row.key] = await decryptString(row.value, secretKey).catch(() => undefined);
    }
  }
  return stored;
}

export async function appConfig(env: Env): Promise<ResolvedConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = resolveConfig(parseConfig(env as unknown as Record<string, unknown>), await readStored(env));
  cache = { at: Date.now(), value };
  return value;
}

/** Store settings (secrets encrypted). `null` removes a value. Only fields present are changed. */
export async function saveConfig(env: Env, patch: Partial<Record<keyof StoredConfig, string | null>>): Promise<void> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  let secretKey: string | null = null;
  for (const [key, value] of Object.entries(patch) as Array<[keyof StoredConfig, string | null | undefined]>) {
    if (value === undefined) continue;
    if (value === null) {
      statements.push(env.DB.prepare("DELETE FROM app_config WHERE key = ?").bind(key));
      continue;
    }
    let stored = value;
    if (SECRET_KEYS.has(key)) {
      secretKey ??= await deriveKey((await masterKey(env.MAIL, true))!, "config");
      stored = await encryptString(value, secretKey);
    }
    statements.push(
      env.DB.prepare("INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(
        key,
        stored,
        now,
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  clearConfigCache();
}

/** Key that encrypts TOTP secrets: TOTP_ENC_KEY if set, else derived from the master key (created if needed). */
export async function totpEncryptionKey(env: Env): Promise<string> {
  const fromEnv = parseConfig(env as unknown as Record<string, unknown>).TOTP_ENC_KEY;
  if (fromEnv) return fromEnv;
  return deriveKey((await masterKey(env.MAIL, true))!, "totp");
}
