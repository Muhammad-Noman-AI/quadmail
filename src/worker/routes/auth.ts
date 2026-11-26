// Track B (Phase 4): login, logout, TOTP, session info.
import { z } from "zod";
import { decryptString, encryptString } from "../auth/crypto";
import { hashPasswordKey, verifyPasswordKey } from "../auth/password";
import { attemptKeys, clearAccount, isLimited, recordFailure } from "../auth/rate-limit";
import { audit, auditStatement, readJson, secured } from "../auth/respond";
import {
  assertSameOrigin,
  clearedSessionCookie,
  clientIp,
  createSession,
  findSession,
  requireSession,
  SESSION_TTL_MS,
  sessionCookie,
} from "../auth/session";
import { generateTotpSecret, matchTotpStep, otpauthUri } from "../auth/totp";
import { totpEncryptionKey } from "../config";
import { HttpError, json } from "../http";
import type { Route } from "../router";

const passwordKey = z.string().regex(/^[0-9a-f]{64}$/);
const totpCode = z.string().regex(/^\d{6}$/);

const loginBody = z.object({ email: z.email().max(254), passwordKey, totp: totpCode.optional() });
const enableBody = z.object({ secret: z.string().regex(/^[A-Z2-7]{32}$/), code: totpCode });
const disableBody = z.object({ passwordKey, code: totpCode });
const passwordBody = z.object({ currentKey: passwordKey, newKey: passwordKey }).refine((b) => b.currentKey !== b.newKey, "same password");

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  totp_secret_enc: string | null;
  disabled: number;
  must_change_password: number;
}

/**
 * Accept a TOTP code at most once (RFC 6238 section 5.2): its time step must be newer than the last
 * accepted one. The conditional UPDATE makes two simultaneous logins with the same code race safely.
 */
async function acceptTotp(db: D1Database, userId: string, secret: string, code: string): Promise<boolean> {
  const step = await matchTotpStep(secret, code);
  if (step === null) return false;
  const result = await db
    .prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)")
    .bind(step, userId, step)
    .run();
  return result.meta.changes > 0;
}

async function loadUser(db: D1Database, by: { email?: string; id?: string }): Promise<UserRow | null> {
  const [column, value] = by.id ? ["id", by.id] : ["email", by.email ?? ""];
  return db.prepare(`SELECT id, email, password_hash, totp_secret_enc, disabled, must_change_password FROM users WHERE ${column} = ?`).bind(value).first<UserRow>();
}


const GENERIC_LOGIN_ERROR = "Incorrect email, password or code";

/** Verified when the email is unknown, so a missing account takes as long as a wrong password. */
const DUMMY_HASH = "v1$00000000000000000000000000000000$" + "0".repeat(64);

const routes: Route[] = [
  {
    method: "POST",
    path: "/api/auth/login",
    handler: async ({ request, env }) => {
      assertSameOrigin(request, env);
      const body = await readJson(request, (v) => loginBody.parse(v));
      const email = body.email.trim().toLowerCase();
      const keys = attemptKeys(clientIp(request), email);
      if (await isLimited(env.DB, keys)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");

      const user = await loadUser(env.DB, { email });
      const passwordOk = await verifyPasswordKey(body.passwordKey, user?.password_hash ?? DUMMY_HASH);
      // A disabled user gets the same answer as a wrong password: no hint that the account exists.
      if (!user || !passwordOk || user.disabled === 1) {
        await recordFailure(env.DB, keys);
        await audit(env.DB, email, "login.failed", { reason: "password" });
        throw new HttpError(401, GENERIC_LOGIN_ERROR);
      }

      if (user.totp_secret_enc) {
        // Password is right; ask for the second factor without counting a failure.
        if (!body.totp) return json({ totpRequired: true }, { status: 401 });
        const secret = await decryptString(user.totp_secret_enc, await totpEncryptionKey(env));
        if (!(await acceptTotp(env.DB, user.id, secret, body.totp))) {
          await recordFailure(env.DB, keys);
          await audit(env.DB, email, "login.failed", { reason: "totp" });
          throw new HttpError(401, GENERIC_LOGIN_ERROR);
        }
      }

      const token = await createSession(env, request, user.id);
      await clearAccount(env.DB, email);
      await audit(env.DB, user.email, "login.success", { ip: clientIp(request) });
      return json({ ok: true, mustChangePassword: user.must_change_password === 1 }, { headers: { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000) } });
    },
  },
  {
    method: "POST",
    path: "/api/auth/logout",
    handler: async ({ request, env }) => {
      assertSameOrigin(request, env);
      const session = await findSession(request, env);
      if (session) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.id),
          auditStatement(env.DB, session.email, "logout"),
        ]);
      }
      return json({ ok: true }, { headers: { "set-cookie": clearedSessionCookie() } });
    },
  },
  {
    method: "POST",
    path: "/api/auth/logout-all",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(session.userId),
        auditStatement(env.DB, session.email, "logout.all"),
      ]);
      return json({ ok: true }, { headers: { "set-cookie": clearedSessionCookie() } });
    },
  },
  {
    // Every user changes their own password here; required after an admin set or reset it.
    method: "POST",
    path: "/api/auth/password",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      const body = await readJson(request, (v) => passwordBody.parse(v));
      // Same throttle as login, so a stolen session cannot guess the current password.
      const keys = attemptKeys(clientIp(request), session.email);
      if (await isLimited(env.DB, keys)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
      const user = await loadUser(env.DB, { id: session.userId });
      if (!user || !(await verifyPasswordKey(body.currentKey, user.password_hash))) {
        await recordFailure(env.DB, keys);
        await audit(env.DB, session.email, "password.change_failed");
        throw new HttpError(401, "The current password is not correct.");
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").bind(await hashPasswordKey(body.newKey), session.userId),
        // Sign out every other device; this one stays signed in.
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").bind(session.userId, session.id),
        auditStatement(env.DB, session.email, "password.changed"),
      ]);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/auth/totp/setup",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      await totpEncryptionKey(env); // fail early if 2FA cannot be stored
      const secret = generateTotpSecret();
      // Nothing is stored yet: the client sends the secret back with a valid code to enable it.
      return json({ secret, uri: otpauthUri(secret, session.email) });
    },
  },
  {
    method: "POST",
    path: "/api/auth/totp/enable",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      const body = await readJson(request, (v) => enableBody.parse(v));
      const step = await matchTotpStep(body.secret, body.code);
      if (step === null) throw new HttpError(400, "That code is not valid. Check your phone's clock and try again.");
      const sealed = await encryptString(body.secret, await totpEncryptionKey(env));
      await env.DB.batch([
        // The code used to turn 2FA on cannot be reused to log in.
        env.DB.prepare("UPDATE users SET totp_secret_enc = ?, totp_last_step = ? WHERE id = ?").bind(sealed, step, session.userId),
        auditStatement(env.DB, session.email, "totp.enabled"),
      ]);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/auth/totp/disable",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      const body = await readJson(request, (v) => disableBody.parse(v));
      const user = await loadUser(env.DB, { id: session.userId });
      if (!user?.totp_secret_enc) throw new HttpError(400, "Two-factor login is not enabled");
      const secret = await decryptString(user.totp_secret_enc, await totpEncryptionKey(env));
      const ok = (await verifyPasswordKey(body.passwordKey, user.password_hash)) && (await acceptTotp(env.DB, user.id, secret, body.code));
      if (!ok) {
        await audit(env.DB, session.email, "totp.disable_failed");
        throw new HttpError(401, GENERIC_LOGIN_ERROR);
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?").bind(session.userId),
        auditStatement(env.DB, session.email, "totp.disabled"),
      ]);
      return json({ ok: true });
    },
  },
];

export const authRoutes: Route[] = routes.map(secured);
