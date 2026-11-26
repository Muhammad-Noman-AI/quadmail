// D1/R2 access for the inbound pipeline (Track A). UI-facing queries live in storage/mail.ts.
import type { Address, AttachmentMeta } from "../../shared/types";
import type { SubjectCandidate } from "../inbound/threading";

export function rawKey(id: string, receivedAt: number): string {
  const d = new Date(receivedAt);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `raw/${d.getUTCFullYear()}/${mm}/${id}.eml`;
}

export function attachmentKey(messageId: string, attachmentId: string): string {
  return `att/${messageId}/${attachmentId}`;
}

/** ID of a raw object key `raw/yyyy/mm/{id}.eml`, or null for anything else. */
export function idFromRawKey(key: string): string | null {
  const match = /^raw\/\d{4}\/\d{2}\/([0-9A-HJKMNP-TV-Z]{26})\.eml$/.exec(key);
  return match ? match[1]! : null;
}

/**
 * Owner of mail sent to `address` (one bound parameter): the active user who has that address as an
 * identity, otherwise the first active admin (catch-all, and mail for disabled users).
 */
const OWNER_SQL = `COALESCE(
  (SELECT i.user_id FROM identities i JOIN users u ON u.id = i.user_id WHERE i.address = ? AND u.disabled = 0),
  (SELECT id FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY created_at LIMIT 1))`;

export async function resolveRecipientOwner(db: D1Database, address: string): Promise<string | null> {
  const row = await db.prepare(`SELECT ${OWNER_SQL} AS user_id`).bind(address.toLowerCase()).first<{ user_id: string | null }>();
  return row?.user_id ?? null;
}

export async function isBlockedSender(db: D1Database, userId: string, addresses: string[]): Promise<boolean> {
  const list = [...new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()))];
  if (list.length === 0) return false;
  const placeholders = list.map(() => "?").join(", ");
  const row = await db.prepare(`SELECT 1 AS hit FROM blocked_senders WHERE user_id = ? AND address IN (${placeholders}) LIMIT 1`).bind(userId, ...list).first();
  return row != null;
}

export async function findThreadByMessageIds(db: D1Database, userId: string, ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => "?").join(", ");
  const row = await db
    .prepare(`SELECT thread_id FROM messages WHERE user_id = ? AND message_id_hdr IN (${placeholders}) AND thread_id IS NOT NULL ORDER BY received_at DESC LIMIT 1`)
    .bind(userId, ...ids)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

export async function findSubjectCandidates(db: D1Database, userId: string, subjectNorm: string, since: number): Promise<SubjectCandidate[]> {
  if (!subjectNorm) return [];
  const { results } = await db
    .prepare(
      `SELECT t.id AS thread_id, t.last_message_at, m.from_addr, m.envelope_from, m.envelope_to, m.to_json
       FROM threads t JOIN messages m ON m.thread_id = t.id
       WHERE t.subject_norm = ? AND t.last_message_at >= ? AND m.user_id = ?
       ORDER BY t.last_message_at DESC LIMIT 50`,
    )
    .bind(subjectNorm, since, userId)
    .all<{ thread_id: string; last_message_at: number; from_addr: string | null; envelope_from: string | null; envelope_to: string | null; to_json: string | null }>();
  const byThread = new Map<string, SubjectCandidate>();
  for (const row of results) {
    const candidate = byThread.get(row.thread_id) ?? { threadId: row.thread_id, lastMessageAt: row.last_message_at, participants: [] };
    for (const value of [row.from_addr, row.envelope_from, row.envelope_to]) if (value) candidate.participants.push(value.toLowerCase());
    for (const address of parseAddressJson(row.to_json)) candidate.participants.push(address.address.toLowerCase());
    byThread.set(row.thread_id, candidate);
  }
  return [...byThread.values()];
}

function parseAddressJson(value: string | null): Address[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((a): a is Address => typeof a?.address === "string") : [];
  } catch {
    return [];
  }
}

export interface InboundRow {
  id: string;
  /** Owner; null resolves it in SQL from envelopeTo (reconcile). */
  userId: string | null;
  threadId: string | null;
  folder: "inbox" | "spam";
  messageIdHdr: string | null;
  inReplyTo: string | null;
  references: string[];
  envelopeFrom: string | null;
  envelopeTo: string | null;
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string | null;
  rawKey: string;
  sizeBytes: number;
  authResults: string | null;
  receivedAt: number;
}

function messageInsert(db: D1Database, row: InboundRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO messages (id, thread_id, direction, folder, message_id_hdr, in_reply_to, references_json,
         envelope_from, envelope_to, from_addr, from_name, to_json, cc_json, subject, raw_key, size_bytes,
         auth_results, parse_status, received_at, user_id)
       VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, COALESCE(?, ${OWNER_SQL}))`,
    )
    .bind(
      row.id,
      row.threadId,
      row.folder,
      row.messageIdHdr,
      row.inReplyTo,
      row.references.length ? JSON.stringify(row.references) : null,
      row.envelopeFrom,
      row.envelopeTo,
      row.from?.address ?? null,
      row.from?.name ?? null,
      JSON.stringify(row.to),
      JSON.stringify(row.cc),
      row.subject,
      row.rawKey,
      row.sizeBytes,
      row.authResults,
      row.receivedAt,
      row.userId,
      row.envelopeTo ?? "",
    );
}

/** One batch (one transaction): create or bump the thread, then insert the message. */
export async function insertInbound(db: D1Database, row: InboundRow & { threadId: string }, thread: { isNew: boolean; subjectNorm: string }): Promise<void> {
  const threadStatement = thread.isNew
    ? db.prepare(`INSERT INTO threads (id, subject_norm, last_message_at, message_count) VALUES (?, ?, ?, 1)`).bind(row.threadId, thread.subjectNorm, row.receivedAt)
    : db
        .prepare(`UPDATE threads SET last_message_at = MAX(last_message_at, ?), message_count = message_count + 1 WHERE id = ?`)
        .bind(row.receivedAt, row.threadId);
  await db.batch([threadStatement, messageInsert(db, row)]);
}

/** Minimal pending row for a raw object found by reconcile (no headers known; the browser parse fills them in). */
export function reconcileInsert(db: D1Database, row: { id: string; rawKey: string; sizeBytes: number; receivedAt: number; envelopeFrom: string | null; envelopeTo: string | null }): D1PreparedStatement {
  return messageInsert(db, {
    ...row,
    userId: null,
    threadId: null,
    folder: "inbox",
    messageIdHdr: null,
    inReplyTo: null,
    references: [],
    from: null,
    to: [],
    cc: [],
    subject: null,
    authResults: null,
  });
}

export async function existingIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  // D1 allows at most 100 bound parameters per query.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT id FROM messages WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of results) found.add(r.id);
  }
  return found;
}

export interface MessageRef {
  id: string;
  threadId: string | null;
  rawKey: string | null;
  parseStatus: "pending" | "done" | "failed";
}

export async function getMessageRef(db: D1Database, userId: string, id: string): Promise<MessageRef | null> {
  const row = await db
    .prepare(`SELECT id, thread_id, raw_key, parse_status FROM messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .bind(id, userId)
    .first<{ id: string; thread_id: string | null; raw_key: string | null; parse_status: MessageRef["parseStatus"] }>();
  return row ? { id: row.id, threadId: row.thread_id, rawKey: row.raw_key, parseStatus: row.parse_status } : null;
}

export interface ParsedFields {
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string | null;
  snippet: string;
  searchText: string;
  hasAttachments: boolean;
}

export async function saveParsed(db: D1Database, ref: MessageRef, fields: ParsedFields, subjectNorm: string): Promise<void> {
  const statements = [
    db
      .prepare(
        `UPDATE messages SET from_addr = COALESCE(?, from_addr), from_name = COALESCE(?, from_name), to_json = ?, cc_json = ?,
           subject = COALESCE(?, subject), snippet = ?, search_text = ?,
           has_attachments = CASE WHEN ? THEN 1 ELSE has_attachments END, parse_status = 'done', parse_error = NULL
         WHERE id = ?`,
      )
      .bind(
        fields.from?.address ?? null,
        fields.from?.name ?? null,
        JSON.stringify(fields.to),
        JSON.stringify(fields.cc),
        fields.subject,
        fields.snippet,
        fields.searchText,
        fields.hasAttachments ? 1 : 0,
        ref.id,
      ),
  ];
  if (ref.threadId && subjectNorm) {
    statements.push(db.prepare(`UPDATE threads SET subject_norm = ? WHERE id = ? AND subject_norm = ''`).bind(subjectNorm, ref.threadId));
  }
  await db.batch(statements);
}

export async function markParseFailed(db: D1Database, id: string, error: string): Promise<void> {
  await db.prepare(`UPDATE messages SET parse_status = 'failed', parse_error = ? WHERE id = ?`).bind(error, id).run();
}

export async function markPending(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE messages SET parse_status = 'pending', parse_error = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND raw_key IS NOT NULL`)
    .bind(id, userId)
    .run();
  return result.meta.changes > 0;
}

export async function pendingIds(db: D1Database, userId: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM messages WHERE user_id = ? AND parse_status = 'pending' AND deleted_at IS NULL AND raw_key IS NOT NULL ORDER BY received_at DESC LIMIT ?`)
    .bind(userId, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function upsertAttachment(db: D1Database, messageId: string, meta: AttachmentMeta, r2Key: string): Promise<void> {
  const statements = [
    db
      .prepare(
        `INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, is_inline)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type,
           size_bytes = excluded.size_bytes, r2_key = excluded.r2_key, content_id = excluded.content_id, is_inline = excluded.is_inline`,
      )
      .bind(meta.id, messageId, meta.filename, meta.contentType, meta.sizeBytes, r2Key, meta.contentId, meta.isInline ? 1 : 0),
  ];
  // Inline images (cid:) are part of the body, not "attachments" for the paperclip icon.
  if (!meta.isInline) statements.push(db.prepare(`UPDATE messages SET has_attachments = 1 WHERE id = ?`).bind(messageId));
  await db.batch(statements);
}

export async function getAttachment(db: D1Database, userId: string, id: string): Promise<{ r2Key: string; filename: string | null; contentType: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT a.r2_key, a.filename, a.content_type FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE a.id = ? AND m.user_id = ? AND m.deleted_at IS NULL`,
    )
    .bind(id, userId)
    .first<{ r2_key: string; filename: string | null; content_type: string | null }>();
  return row ? { r2Key: row.r2_key, filename: row.filename, contentType: row.content_type } : null;
}

export async function getJobState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM job_state WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setJobState(db: D1Database, key: string, value: string | null): Promise<void> {
  if (value == null) await db.prepare(`DELETE FROM job_state WHERE key = ?`).bind(key).run();
  else
    await db
      .prepare(`INSERT INTO job_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(key, value, Date.now())
      .run();
}
