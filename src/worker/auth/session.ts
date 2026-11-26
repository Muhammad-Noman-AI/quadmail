// CONTRACT, owned by Track B (Phase 4). Track A calls requireSession on every /api route it adds.
import { parseConfig, type AppConfig } from "../../shared/env";
import type { Role } from "../../shared/types";
import { HttpError } from "../http";
import { randomBytes, sha256Hex, toHex } from "./crypto";

export type { Role };

export interface Session {
  id: string;
  userId: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

export const SESSION_COOKIE = "__Host-qm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function config(env: Env): AppConfig {
  return parseConfig(env as unknown as Record<string, unknown>);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/**
 * `__Host-` requires Secure, Path=/ and no Domain. Browsers accept Secure cookies on
 * http://localhost (it is a secure context), so the same cookie works in local dev.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return sessionCookie("", 0);
}

/**
 * CSRF defence for cookie-authenticated mutations. The Origin header cannot be forged by another
 * site. Accepted: the configured APP_URL origin, or the origin the request was actually sent to
 * (so the workers.dev URL keeps working next to a custom domain).
 */
export function assertSameOrigin(request: Request, env: Env): void {
  if (!MUTATING.has(request.method)) return;
  const origin = request.headers.get("origin");
  const allowed = new Set([new URL(config(env).APP_URL).origin, new URL(request.url).origin]);
  if (!origin || !allowed.has(origin)) throw new HttpError(403, "Cross-origin request rejected");
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

export async function createSession(env: Env, request: Request, userId: string): Promise<string> {
  const token = toHex(randomBytes(32));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(userId, now),
    env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      await sha256Hex(token),
      userId,
      now + SESSION_TTL_MS,
      clientIp(request),
      (request.headers.get("user-agent") ?? "").slice(0, 200),
      now,
    ),
  ]);
  return token;
}

/** Session for the request's cookie, or null (also for disabled users). Does not check Origin. */
export async function findSession(request: Request, env: Env): Promise<Session | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT s.id, s.user_id, u.email, u.role, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0`,
  )
    .bind(await sha256Hex(token), Date.now())
    .first<{ id: string; user_id: string; email: string; role: Role; must_change_password: number }>();
  return row ? { id: row.id, userId: row.user_id, email: row.email, role: row.role, mustChangePassword: row.must_change_password === 1 } : null;
}

/** Returns the session for a valid cookie, or throws HttpError(401). Also enforces the Origin check on mutating requests. */
export async function requireSession(request: Request, env: Env): Promise<Session> {
  assertSameOrigin(request, env);
  const session = await findSession(request, env);
  if (!session) throw new HttpError(401, "Not signed in");
  return session;
}

/** Like requireSession, but only for admins (team management, addresses). */
export async function requireAdmin(request: Request, env: Env): Promise<Session> {
  const session = await requireSession(request, env);
  if (session.role !== "admin") throw new HttpError(403, "Only an admin can do this");
  return session;
}
