// Track B (Phase 4): message lists, threads, search, folder actions, labels, blocked senders.
import { z } from "zod";
import { FOLDERS, type Folder } from "../../shared/types";
import { ulid } from "../../shared/ulid";
import { auditStatement, readJson, secured } from "../auth/respond";
import { requireSession } from "../auth/session";
import { HttpError, json } from "../http";
import type { Route } from "../router";
import {
  bulkUpdateStatements,
  decodeCursor,
  folderCounts,
  getMessage,
  getThread,
  listMessages,
  parseSearch,
  searchMessages,
} from "../storage/mail";

const id = z.string().regex(/^[0-9A-Z]{26}$/);
const folder = z.enum(FOLDERS as [Folder, ...Folder[]]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const bulkBody = z
  .object({
    ids: z.array(id).min(1).max(500),
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    folder: folder.optional(),
    addLabels: z.array(id).max(20).optional(),
    removeLabels: z.array(id).max(20).optional(),
  })
  .refine((b) => b.isRead !== undefined || b.isStarred !== undefined || b.folder || b.addLabels?.length || b.removeLabels?.length, "no change");

const labelBody = z.object({ name: z.string().trim().min(1).max(40), color: color.optional() });
const labelPatch = z.object({ name: z.string().trim().min(1).max(40).optional(), color: color.nullable().optional() });

function param(value: string | undefined): string {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid id");
  return parsed.data;
}

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/me",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      const user = await env.DB.prepare("SELECT totp_secret_enc IS NOT NULL AS totp FROM users WHERE id = ?").bind(session.userId).first<{ totp: number }>();
      return json({ email: session.email, totpEnabled: user?.totp === 1 });
    },
  },
  {
    method: "GET",
    path: "/api/counts",
    handler: async ({ request, env }) => {
      await requireSession(request, env);
      return json(await folderCounts(env.DB));
    },
  },
  {
    method: "GET",
    path: "/api/messages",
    handler: async ({ request, env, url }) => {
      await requireSession(request, env);
      const q = url.searchParams;
      const folderValue = folder.safeParse(q.get("folder") ?? "inbox");
      if (!folderValue.success) throw new HttpError(400, "Invalid folder");
      const label = q.get("label");
      const cursorValue = q.get("cursor");
      const cursor = cursorValue ? decodeCursor(cursorValue) : null;
      if (cursorValue && !cursor) throw new HttpError(400, "Invalid cursor");
      const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 100);
      return json(
        await listMessages(env.DB, {
          folder: folderValue.data,
          labelId: label ? param(label) : undefined,
          starred: q.get("starred") === "1",
          cursor,
          limit,
        }),
      );
    },
  },
  {
    method: "PATCH",
    path: "/api/messages",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      const body = await readJson(request, (v) => bulkBody.parse(v));
      const statements = bulkUpdateStatements(env.DB, body);
      if (body.folder === "trash") statements.push(auditStatement(env.DB, session.email, "messages.trash", { count: body.ids.length }));
      await env.DB.batch(statements);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    path: "/api/messages/:id",
    handler: async ({ request, env, params }) => {
      await requireSession(request, env);
      const message = await getMessage(env.DB, param(params.id));
      if (!message) throw new HttpError(404, "Message not found");
      return json(message);
    },
  },
  {
    method: "POST",
    path: "/api/messages/:id/block-sender",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const messageId = param(params.id);
      const row = await env.DB.prepare("SELECT from_addr FROM messages WHERE id = ?").bind(messageId).first<{ from_addr: string | null }>();
      if (!row?.from_addr) throw new HttpError(404, "Sender not found");
      const address = row.from_addr.toLowerCase();
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO blocked_senders (address, created_at) VALUES (?, ?)").bind(address, Date.now()),
        env.DB.prepare("UPDATE messages SET folder = 'spam' WHERE from_addr = ? COLLATE NOCASE AND folder = 'inbox'").bind(address),
        auditStatement(env.DB, session.email, "sender.blocked", { address }),
      ]);
      return json({ ok: true, address });
    },
  },
  {
    method: "GET",
    path: "/api/threads/:id",
    handler: async ({ request, env, params }) => {
      await requireSession(request, env);
      const messages = await getThread(env.DB, param(params.id));
      if (!messages.length) throw new HttpError(404, "Thread not found");
      return json({ id: params.id, messages });
    },
  },
  {
    method: "GET",
    path: "/api/search",
    handler: async ({ request, env, url }) => {
      await requireSession(request, env);
      const q = (url.searchParams.get("q") ?? "").slice(0, 500);
      const query = parseSearch(q);
      return json({ items: await searchMessages(env.DB, query) });
    },
  },
  {
    method: "GET",
    path: "/api/labels",
    handler: async ({ request, env }) => {
      await requireSession(request, env);
      const { results } = await env.DB.prepare("SELECT id, name, color FROM labels ORDER BY name COLLATE NOCASE").all();
      return json({ items: results });
    },
  },
  {
    method: "POST",
    path: "/api/labels",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      const body = await readJson(request, (v) => labelBody.parse(v));
      const label = { id: ulid(), name: body.name, color: body.color ?? null };
      try {
        await env.DB.batch([
          env.DB.prepare("INSERT INTO labels (id, name, color) VALUES (?, ?, ?)").bind(label.id, label.name, label.color),
          auditStatement(env.DB, session.email, "label.created", { id: label.id }),
        ]);
      } catch {
        throw new HttpError(409, "A label with that name already exists");
      }
      return json(label, { status: 201 });
    },
  },
  {
    method: "PATCH",
    path: "/api/labels/:id",
    handler: async ({ request, env, params }) => {
      await requireSession(request, env);
      const labelId = param(params.id);
      const body = await readJson(request, (v) => labelPatch.parse(v));
      await env.DB.prepare("UPDATE labels SET name = COALESCE(?, name), color = CASE WHEN ? THEN ? ELSE color END WHERE id = ?")
        .bind(body.name ?? null, body.color !== undefined ? 1 : 0, body.color ?? null, labelId)
        .run();
      return json({ ok: true });
    },
  },
  {
    method: "DELETE",
    path: "/api/labels/:id",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const labelId = param(params.id);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM labels WHERE id = ?").bind(labelId),
        auditStatement(env.DB, session.email, "label.deleted", { id: labelId }),
      ]);
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    path: "/api/blocked-senders",
    handler: async ({ request, env }) => {
      await requireSession(request, env);
      const { results } = await env.DB.prepare("SELECT address, created_at AS createdAt FROM blocked_senders ORDER BY created_at DESC").all();
      return json({ items: results });
    },
  },
  {
    method: "DELETE",
    path: "/api/blocked-senders/:address",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const address = (params.address ?? "").toLowerCase();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM blocked_senders WHERE address = ?").bind(address),
        auditStatement(env.DB, session.email, "sender.unblocked", { address }),
      ]);
      return json({ ok: true });
    },
  },
];

export const mailRoutes: Route[] = routes.map(secured);
