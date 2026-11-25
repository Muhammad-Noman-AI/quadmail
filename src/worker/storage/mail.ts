// Track B repository layer over D1 for reading and organising mail. Parameterised SQL only.
import type { Address, AttachmentMeta, Folder, MessageDetail, MessageSummary } from "../../shared/types";

/** D1 allows 100 bound parameters per statement; keep id lists well under it. */
const ID_CHUNK = 90;

export interface MessageRow {
  id: string;
  thread_id: string | null;
  folder: Folder;
  direction: "in" | "out";
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  parse_status: "pending" | "done" | "failed";
  label_ids: string | null;
  message_id_hdr?: string | null;
  in_reply_to?: string | null;
  references_json?: string | null;
  auth_results?: string | null;
}

const SUMMARY_COLUMNS = `m.id, m.thread_id, m.folder, m.direction, m.from_addr, m.from_name, m.to_json, m.cc_json,
  m.subject, m.snippet, m.received_at, m.is_read, m.is_starred, m.has_attachments, m.parse_status,
  (SELECT group_concat(label_id) FROM message_labels ml WHERE ml.message_id = m.id) AS label_ids`;

const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, m.message_id_hdr, m.in_reply_to, m.references_json, m.auth_results`;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function addresses(value: string | null | undefined): Address[] {
  const list = parseJson<unknown>(value, []);
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (typeof item === "string") return [{ address: item }];
    if (item && typeof item === "object" && typeof (item as Address).address === "string") {
      const { address, name } = item as Address;
      return [name ? { address, name } : { address }];
    }
    return [];
  });
}

export function toSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    threadId: row.thread_id,
    folder: row.folder,
    direction: row.direction,
    from: row.from_addr ? (row.from_name ? { address: row.from_addr, name: row.from_name } : { address: row.from_addr }) : null,
    to: addresses(row.to_json),
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.received_at,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    hasAttachments: row.has_attachments === 1,
    parseStatus: row.parse_status,
    labelIds: row.label_ids ? row.label_ids.split(",") : [],
  };
}

function toDetail(row: MessageRow, attachments: AttachmentMeta[]): MessageDetail {
  return {
    ...toSummary(row),
    cc: addresses(row.cc_json),
    messageIdHeader: row.message_id_hdr ?? null,
    inReplyTo: row.in_reply_to ?? null,
    references: parseJson<string[]>(row.references_json, []),
    authResults: row.auth_results ?? null,
    attachments,
  };
}

export function encodeCursor(row: { received_at: number; id: string }): string {
  return btoa(`${row.received_at}:${row.id}`);
}

export function decodeCursor(cursor: string): { receivedAt: number; id: string } | null {
  try {
    const [time, id] = atob(cursor).split(":");
    const receivedAt = Number(time);
    return Number.isFinite(receivedAt) && id && /^[0-9A-Z]{26}$/.test(id) ? { receivedAt, id } : null;
  } catch {
    return null;
  }
}

export interface ListQuery {
  folder?: Folder;
  labelId?: string;
  starred?: boolean;
  cursor?: { receivedAt: number; id: string } | null;
  limit: number;
}

export async function listMessages(db: D1Database, query: ListQuery): Promise<{ items: MessageSummary[]; nextCursor: string | null }> {
  const where = ["m.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (query.starred) {
    where.push("m.is_starred = 1", "m.folder NOT IN ('trash', 'spam')");
  } else if (query.labelId) {
    where.push("EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)", "m.folder <> 'trash'");
    params.push(query.labelId);
  } else {
    where.push("m.folder = ?");
    params.push(query.folder ?? "inbox");
  }
  if (query.cursor) {
    where.push("(m.received_at < ? OR (m.received_at = ? AND m.id < ?))");
    params.push(query.cursor.receivedAt, query.cursor.receivedAt, query.cursor.id);
  }
  const { results } = await db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.received_at DESC, m.id DESC LIMIT ?`)
    .bind(...params, query.limit + 1)
    .all<MessageRow>();
  const page = results.slice(0, query.limit);
  const last = page.at(-1);
  return { items: page.map(toSummary), nextCursor: results.length > query.limit && last ? encodeCursor(last) : null };
}

async function attachmentsFor(db: D1Database, messageIds: string[]): Promise<Map<string, AttachmentMeta[]>> {
  const map = new Map<string, AttachmentMeta[]>();
  for (let i = 0; i < messageIds.length; i += ID_CHUNK) {
    const chunk = messageIds.slice(i, i + ID_CHUNK);
    const { results } = await db
      .prepare(
        `SELECT id, message_id, filename, content_type, size_bytes, content_id, is_inline FROM attachments WHERE message_id IN (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(...chunk)
      .all<{ id: string; message_id: string; filename: string | null; content_type: string | null; size_bytes: number; content_id: string | null; is_inline: number }>();
    for (const row of results) {
      const list = map.get(row.message_id) ?? [];
      list.push({
        id: row.id,
        filename: row.filename,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        contentId: row.content_id,
        isInline: row.is_inline === 1,
      });
      map.set(row.message_id, list);
    }
  }
  return map;
}

export async function getMessage(db: D1Database, id: string): Promise<MessageDetail | null> {
  const row = await db.prepare(`SELECT ${DETAIL_COLUMNS} FROM messages m WHERE m.id = ? AND m.deleted_at IS NULL`).bind(id).first<MessageRow>();
  if (!row) return null;
  const attachments = await attachmentsFor(db, [id]);
  return toDetail(row, attachments.get(id) ?? []);
}

export async function getThread(db: D1Database, threadId: string): Promise<MessageDetail[]> {
  const { results } = await db
    .prepare(`SELECT ${DETAIL_COLUMNS} FROM messages m WHERE m.thread_id = ? AND m.deleted_at IS NULL ORDER BY m.received_at ASC, m.id ASC`)
    .bind(threadId)
    .all<MessageRow>();
  const attachments = await attachmentsFor(db, results.map((row) => row.id));
  return results.map((row) => toDetail(row, attachments.get(row.id) ?? []));
}

export async function folderCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT folder, COUNT(*) AS n FROM messages WHERE deleted_at IS NULL AND is_read = 0 AND folder IN ('inbox', 'spam') GROUP BY folder
       UNION ALL SELECT 'drafts', COUNT(*) FROM messages WHERE deleted_at IS NULL AND folder = 'drafts'`,
    )
    .all<{ folder: string; n: number }>();
  return Object.fromEntries(results.map((row) => [row.folder, row.n]));
}

export interface BulkUpdate {
  ids: string[];
  isRead?: boolean;
  isStarred?: boolean;
  folder?: Folder;
  addLabels?: string[];
  removeLabels?: string[];
}

/** All changes for all ids in one D1 batch (one round trip, atomic). */
export function bulkUpdateStatements(db: D1Database, update: BulkUpdate): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const sets: string[] = [];
  const values: unknown[] = [];
  if (update.isRead !== undefined) {
    sets.push("is_read = ?");
    values.push(update.isRead ? 1 : 0);
  }
  if (update.isStarred !== undefined) {
    sets.push("is_starred = ?");
    values.push(update.isStarred ? 1 : 0);
  }
  if (update.folder) {
    sets.push("folder = ?");
    values.push(update.folder);
  }
  for (let i = 0; i < update.ids.length; i += ID_CHUNK) {
    const chunk = update.ids.slice(i, i + ID_CHUNK);
    const inList = chunk.map(() => "?").join(", ");
    if (sets.length) {
      statements.push(db.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id IN (${inList})`).bind(...values, ...chunk));
    }
    for (const labelId of update.addLabels ?? []) {
      statements.push(
        db
          .prepare(`INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT id, ? FROM messages WHERE id IN (${inList}) AND EXISTS (SELECT 1 FROM labels WHERE id = ?)`)
          .bind(labelId, ...chunk, labelId),
      );
    }
    for (const labelId of update.removeLabels ?? []) {
      statements.push(db.prepare(`DELETE FROM message_labels WHERE label_id = ? AND message_id IN (${inList})`).bind(labelId, ...chunk));
    }
  }
  return statements;
}

// ---- Search -------------------------------------------------------------------------------

export interface SearchQuery {
  terms: string[];
  from?: string;
  to?: string;
  hasAttachment?: boolean;
  before?: number;
  after?: number;
  folder?: Folder;
}

const FOLDER_NAMES = new Set<string>(["inbox", "sent", "drafts", "archive", "spam", "trash"]);

/** Splits a Gmail-style query into free-text terms and filters. Quoted phrases stay together. */
export function parseSearch(input: string): SearchQuery {
  const query: SearchQuery = { terms: [] };
  const tokens = input.match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) ?? [];
  for (const raw of tokens) {
    const match = /^(from|to|has|before|after|in):(.*)$/i.exec(raw);
    const unquote = (value: string) => value.replace(/^"(.*)"$/, "$1").trim();
    if (!match) {
      const term = unquote(raw);
      if (term) query.terms.push(term);
      continue;
    }
    const key = match[1]!.toLowerCase();
    const value = unquote(match[2]!);
    if (!value) continue;
    if (key === "from") query.from = value;
    else if (key === "to") query.to = value;
    else if (key === "has" && value.toLowerCase() === "attachment") query.hasAttachment = true;
    else if (key === "in" && FOLDER_NAMES.has(value.toLowerCase())) query.folder = value.toLowerCase() as Folder;
    else if (key === "before" || key === "after") {
      const time = Date.parse(`${value}T00:00:00Z`);
      if (Number.isFinite(time)) query[key] = time;
    } else query.terms.push(unquote(raw));
  }
  return query;
}

/** FTS5 MATCH expression: every term quoted (no operator injection), prefix-matched, ANDed. */
export function ftsExpression(terms: string[]): string | null {
  const parts = terms
    .map((term) => term.replace(/"/g, '""').trim())
    .filter(Boolean)
    .map((term) => `"${term}"*`);
  return parts.length ? parts.join(" ") : null;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchMessages(db: D1Database, query: SearchQuery, limit = 50): Promise<MessageSummary[]> {
  const where = ["m.deleted_at IS NULL"];
  const params: unknown[] = [];
  const fts = ftsExpression(query.terms);
  if (fts) {
    where.push("m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
    params.push(fts);
  }
  if (query.from) {
    where.push("(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')");
    params.push(likePattern(query.from), likePattern(query.from));
  }
  if (query.to) {
    where.push("(m.to_json LIKE ? ESCAPE '\\' OR m.cc_json LIKE ? ESCAPE '\\')");
    params.push(likePattern(query.to), likePattern(query.to));
  }
  if (query.hasAttachment) where.push("m.has_attachments = 1");
  if (query.before !== undefined) {
    where.push("m.received_at < ?");
    params.push(query.before);
  }
  if (query.after !== undefined) {
    where.push("m.received_at >= ?");
    params.push(query.after);
  }
  if (query.folder) {
    where.push("m.folder = ?");
    params.push(query.folder);
  } else {
    where.push("m.folder NOT IN ('trash', 'spam')");
  }
  const { results } = await db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.received_at DESC, m.id DESC LIMIT ?`)
    .bind(...params, limit)
    .all<MessageRow>();
  return results.map(toSummary);
}
