// Team management (admin only): users of this QuadMail, their roles and their addresses.
// Passwords never reach the server: the admin's browser derives the new user's key (src/web/auth/kdf.ts).
import { z } from "zod";
import type { Role, TeamMember } from "../../shared/types";
import { ulid } from "../../shared/ulid";
import { hashPasswordKey } from "../auth/password";
import { auditStatement, readJson, secured } from "../auth/respond";
import { config, requireAdmin } from "../auth/session";
import { HttpError, json } from "../http";
import type { Route } from "../router";
import { domainOf } from "../send/rules";

const id = z.string().regex(/^[0-9A-Z]{26}$/);
const passwordKey = z.string().regex(/^[0-9a-f]{64}$/);
const role = z.enum(["admin", "member"]);
const displayName = z.string().trim().max(100).nullable();

const createBody = z.object({ email: z.email().max(254), displayName: displayName.optional(), role, passwordKey });
const patchBody = z.object({ displayName: displayName.optional(), role: role.optional(), disabled: z.boolean().optional(), passwordKey: passwordKey.optional() });
const addressBody = z.object({ address: z.email().max(254) });

function param(value: string | undefined): string {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid id");
  return parsed.data;
}

function allowedAddress(env: Env, address: string): string {
  const domains = config(env).ALLOWED_SENDING_DOMAINS;
  const lower = address.trim().toLowerCase();
  if (!domains.includes(domainOf(lower))) throw new HttpError(400, `Only addresses on ${domains.join(", ")} can be used.`);
  return lower;
}

/** Who owns an address already (login email or alias), so it is never given to two people. */
async function addressOwner(db: D1Database, address: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT COALESCE((SELECT u.email FROM identities i JOIN users u ON u.id = i.user_id WHERE i.address = ?), (SELECT email FROM users WHERE email = ?)) AS owner")
    .bind(address, address)
    .first<{ owner: string | null }>();
  return row?.owner ?? null;
}

async function listTeam(db: D1Database): Promise<TeamMember[]> {
  const [users, identities] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT id, email, display_name, role, disabled, must_change_password, totp_secret_enc IS NOT NULL AS totp, created_at FROM users ORDER BY created_at"),
    db.prepare("SELECT id, user_id, address FROM identities ORDER BY address"),
  ]);
  return (users!.results as Array<{ id: string; email: string; display_name: string | null; role: Role; disabled: number; must_change_password: number; totp: number; created_at: number }>).map(
    (u) => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      role: u.role,
      disabled: u.disabled === 1,
      mustChangePassword: u.must_change_password === 1,
      totpEnabled: u.totp === 1,
      createdAt: u.created_at,
      addresses: (identities!.results as Array<{ id: string; user_id: string; address: string }>)
        .filter((i) => i.user_id === u.id && i.address.toLowerCase() !== u.email.toLowerCase())
        .map((i) => ({ id: i.id, address: i.address })),
    }),
  );
}

async function activeAdminCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").first<{ n: number }>();
  return row?.n ?? 0;
}

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/team",
    handler: async ({ request, env }) => {
      await requireAdmin(request, env);
      return json({ items: await listTeam(env.DB) });
    },
  },
  {
    method: "POST",
    path: "/api/team",
    handler: async ({ request, env }) => {
      const session = await requireAdmin(request, env);
      const body = await readJson(request, (v) => createBody.parse(v));
      const email = allowedAddress(env, body.email);
      const owner = await addressOwner(env.DB, email);
      if (owner) throw new HttpError(409, owner === email ? "A user with this email already exists." : `${email} is already an address of ${owner}.`);
      const userId = ulid();
      await env.DB.batch([
        env.DB
          .prepare("INSERT INTO users (id, email, password_hash, created_at, role, display_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)")
          .bind(userId, email, await hashPasswordKey(body.passwordKey), Date.now(), body.role, body.displayName || null),
        // The login address is the user's default identity, so mail to it lands in their inbox.
        env.DB.prepare("INSERT INTO identities (id, user_id, address, display_name, is_default) VALUES (?, ?, ?, ?, 1)").bind(ulid(), userId, email, body.displayName || null),
        auditStatement(env.DB, session.email, "user.created", { email, role: body.role }),
      ]);
      return json({ id: userId }, { status: 201 });
    },
  },
  {
    method: "PATCH",
    path: "/api/team/:id",
    handler: async ({ request, env, params }) => {
      const session = await requireAdmin(request, env);
      const userId = param(params.id);
      const body = await readJson(request, (v) => patchBody.parse(v));
      const user = await env.DB.prepare("SELECT email, role, disabled FROM users WHERE id = ?").bind(userId).first<{ email: string; role: Role; disabled: number }>();
      if (!user) throw new HttpError(404, "User not found");
      const self = userId === session.userId;
      if (self && (body.disabled || body.role === "member")) throw new HttpError(400, "You cannot disable yourself or remove your own admin role.");
      const losesAdmin = user.role === "admin" && user.disabled === 0 && (body.disabled === true || body.role === "member");
      if (losesAdmin && (await activeAdminCount(env.DB)) <= 1) throw new HttpError(400, "There must always be at least one active admin.");

      const statements: D1PreparedStatement[] = [];
      if (body.displayName !== undefined) statements.push(env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(body.displayName || null, userId));
      if (body.role) statements.push(env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(body.role, userId));
      if (body.disabled !== undefined) statements.push(env.DB.prepare("UPDATE users SET disabled = ? WHERE id = ?").bind(body.disabled ? 1 : 0, userId));
      if (body.passwordKey) {
        // A reset password is temporary: the user must choose a new one at the next login.
        statements.push(env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").bind(await hashPasswordKey(body.passwordKey), userId));
      }
      if (body.disabled || body.passwordKey) statements.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId));
      if (!statements.length) return json({ ok: true });
      statements.push(
        auditStatement(env.DB, session.email, "user.updated", {
          email: user.email,
          ...(body.role ? { role: body.role } : {}),
          ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
          ...(body.passwordKey ? { passwordReset: true } : {}),
        }),
      );
      await env.DB.batch(statements);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/team/:id/addresses",
    handler: async ({ request, env, params }) => {
      const session = await requireAdmin(request, env);
      const userId = param(params.id);
      const body = await readJson(request, (v) => addressBody.parse(v));
      const address = allowedAddress(env, body.address);
      const exists = await env.DB.prepare("SELECT 1 AS ok FROM users WHERE id = ?").bind(userId).first();
      if (!exists) throw new HttpError(404, "User not found");
      const owner = await addressOwner(env.DB, address);
      if (owner) throw new HttpError(409, `${address} already belongs to ${owner}.`);
      const identityId = ulid();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO identities (id, user_id, address, is_default) VALUES (?, ?, ?, 0)").bind(identityId, userId, address),
        auditStatement(env.DB, session.email, "address.added", { address, userId }),
      ]);
      return json({ id: identityId, address }, { status: 201 });
    },
  },
  {
    method: "DELETE",
    path: "/api/team/:id/addresses/:identityId",
    handler: async ({ request, env, params }) => {
      const session = await requireAdmin(request, env);
      const userId = param(params.id);
      const identityId = param(params.identityId);
      // The login address and the default From address stay; anything else can be removed.
      const [removed] = await env.DB.batch([
        env.DB
          .prepare("DELETE FROM identities WHERE id = ? AND user_id = ? AND is_default = 0 AND address <> (SELECT email FROM users WHERE id = ?)")
          .bind(identityId, userId, userId),
        auditStatement(env.DB, session.email, "address.removed", { identityId, userId }),
      ]);
      if (!removed?.meta.changes) throw new HttpError(400, "The login address and the default From address cannot be removed.");
      return json({ ok: true });
    },
  },
];

export const teamRoutes: Route[] = routes.map(secured);
