// D1/R2 access for mail written in QuadMail: identities, drafts, sending state, quota, suppressions.
// Drafts and sent mail keep their body in R2 (`out/{id}/body.json`), never in D1.
import type { DraftInput, Identity } from "../../shared/types";
import type { DeliveryUpdate } from "../send/webhook";

export function bodyKey(messageId: string): string {
  return `out/${messageId}/body.json`;
}

export function outgoingAttachmentKey(messageId: string, attachmentId: string): string {
  return `out/${messageId}/${attachmentId}`;
}

/** Base64 copy written at upload time, so sending never encodes on the Worker's CPU budget. */
export function base64Key(r2Key: string): string {
  return `${r2Key}.b64`;
}

// ---- Identities ----

interface IdentityRow {
  id: string;
  address: string;
  display_name: string | null;
  signature_html: string | null;
  is_default: number;
}

function toIdentity(row: IdentityRow): Identity {
  return { id: row.id, address: row.address, displayName: row.display_name, signatureHtml: row.signature_html, isDefault: row.is_default === 1 };
}

export async function listIdentities(db: D1Database, userId: string): Promise<Identity[]> {
  const { results } = await db
    .prepare("SELECT id, address, display_name, signature_html, is_default FROM identities WHERE user_id = ? ORDER BY is_default DESC, address")
    .bind(userId)
    .all<IdentityRow>();
  return results.map(toIdentity);
}

export function insertIdentity(db: D1Database, identity: Identity & { userId: string }): D1PreparedStatement {
  return db
    .prepare("INSERT OR IGNORE INTO identities (id, user_id, address, display_name, signature_html, is_default) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(identity.id, identity.userId, identity.address.toLowerCase(), identity.displayName, identity.signatureHtml, identity.isDefault ? 1 : 0);
}

export function updateIdentity(
  db: D1Database,
  userId: string,
  id: string,
  patch: { displayName?: string | null; signatureHtml?: string | null },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE identities SET
         display_name = CASE WHEN ? THEN ? ELSE display_name END,
         signature_html = CASE WHEN ? THEN ? ELSE signature_html END
       WHERE id = ? AND user_id = ?`,
    )
    .bind(
      patch.displayName !== undefined ? 1 : 0,
      patch.displayName ?? null,
      patch.signatureHtml !== undefined ? 1 : 0,
      patch.signatureHtml ?? null,
      id,
      userId,
    );
}

export function setDefaultIdentity(db: D1Database, userId: string, id: string): D1PreparedStatement {
  return db.prepare("UPDATE identities SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ?").bind(id, userId);
}

// ---- Quota ----

export async function sentOn(db: D1Database, day: string): Promise<number> {
  const row = await db.prepare("SELECT count FROM send_counters WHERE day = ?").bind(day).first<{ count: number }>();
  return row?.count ?? 0;
}

/** Atomically add `count` to today's counter unless that would pass `limit`. True when reserved. */
export async function reserveQuota(db: D1Database, day: string, count: number, limit: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO send_counters (day, count) SELECT ?, ? WHERE ? <= ?
       ON CONFLICT(day) DO UPDATE SET count = count + excluded.count WHERE count + excluded.count <= ?`,
    )
    .bind(day, count, count, limit, limit)
    .run();
  return result.meta.changes > 0;
}

export function releaseQuota(db: D1Database, day: string, count: number): D1PreparedStatement {
  return db.prepare("UPDATE send_counters SET count = MAX(count - ?, 0) WHERE day = ?").bind(count, day);
}

// ---- Drafts ----

export interface DraftFields extends Omit<DraftInput, "html" | "text"> {
  fromName: string | null;
  snippet: string;
  searchText: string;
}

export function insertDraft(
  db: D1Database,
  userId: string,
  id: string,
  fields: DraftFields,
  reply: { inReplyTo: string | null; references: string[] },
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO messages (id, user_id, direction, folder, in_reply_to, references_json, from_addr, from_name, to_json, cc_json, bcc_json,
         subject, snippet, search_text, html_key, is_read, parse_status, received_at)
       VALUES (?, ?, 'out', 'drafts', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'done', ?)`,
    )
    .bind(
      id,
      userId,
      reply.inReplyTo,
      reply.references.length ? JSON.stringify(reply.references) : null,
      fields.from.toLowerCase(),
      fields.fromName,
      JSON.stringify(fields.to),
      JSON.stringify(fields.cc),
      JSON.stringify(fields.bcc),
      fields.subject,
      fields.snippet,
      fields.searchText,
      bodyKey(id),
      now,
    );
}

/** Update a draft in place. Zero changes means it is not a draft any more (sent or deleted). */
export async function updateDraft(db: D1Database, userId: string, id: string, fields: DraftFields, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE messages SET from_addr = ?, from_name = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, snippet = ?,
         search_text = ?, received_at = ?
       WHERE id = ? AND user_id = ? AND folder = 'drafts' AND direction = 'out' AND deleted_at IS NULL`,
    )
    .bind(
      fields.from.toLowerCase(),
      fields.fromName,
      JSON.stringify(fields.to),
      JSON.stringify(fields.cc),
      JSON.stringify(fields.bcc),
      fields.subject,
      fields.snippet,
      fields.searchText,
      now,
      id,
      userId,
    )
    .run();
  return result.meta.changes > 0;
}

export interface DraftRow {
  id: string;
  from_addr: string | null;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  html_key: string | null;
  received_at: number;
}

export async function getDraft(db: D1Database, userId: string, id: string): Promise<DraftRow | null> {
  return db
    .prepare(
      `SELECT id, from_addr, from_name, to_json, cc_json, bcc_json, subject, in_reply_to, references_json, html_key, received_at
       FROM messages WHERE id = ? AND user_id = ? AND folder = 'drafts' AND direction = 'out' AND deleted_at IS NULL`,
    )
    .bind(id, userId)
    .first<DraftRow>();
}

export interface OutgoingAttachmentRow {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  r2_key: string;
}

export async function attachmentsOf(db: D1Database, messageId: string): Promise<OutgoingAttachmentRow[]> {
  const { results } = await db
    .prepare("SELECT id, filename, content_type, size_bytes, r2_key FROM attachments WHERE message_id = ? ORDER BY id")
    .bind(messageId)
    .all<OutgoingAttachmentRow>();
  return results;
}

export function deleteAttachmentStatements(db: D1Database, messageId: string, attachmentId: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM attachments WHERE id = ? AND message_id = ?").bind(attachmentId, messageId),
    db
      .prepare("UPDATE messages SET has_attachments = EXISTS (SELECT 1 FROM attachments WHERE message_id = ? AND is_inline = 0) WHERE id = ?")
      .bind(messageId, messageId),
  ];
}

/** Message, its attachment rows (cascade) and FTS entry (trigger). R2 objects are deleted by the caller. */
export function deleteDraftStatement(db: D1Database, userId: string, id: string): D1PreparedStatement {
  return db.prepare("DELETE FROM messages WHERE id = ? AND user_id = ? AND folder = 'drafts' AND direction = 'out'").bind(id, userId);
}

// ---- Sending ----

/** Move the draft into Sent as `queued`. Only one concurrent send can win; false if it was not a draft. */
export async function claimDraft(db: D1Database, id: string, savedAt: number, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE messages SET folder = 'sent', send_status = 'queued', received_at = ?, sent_at = ?
       WHERE id = ? AND folder = 'drafts' AND direction = 'out' AND received_at = ?`,
    )
    .bind(now, now, id, savedAt)
    .run();
  return result.meta.changes > 0;
}

/** Put a claimed message back as a draft after a failed send, keeping the reason visible. */
export function unclaimStatement(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE messages SET folder = 'drafts', send_status = 'failed', sent_at = NULL, received_at = ? WHERE id = ?").bind(now, id);
}

export function markSentStatements(
  db: D1Database,
  id: string,
  providerMessageId: string,
  thread: { id: string; isNew: boolean; subjectNorm: string },
  now: number,
): D1PreparedStatement[] {
  return [
    thread.isNew
      ? db.prepare("INSERT INTO threads (id, subject_norm, last_message_at, message_count) VALUES (?, ?, ?, 1)").bind(thread.id, thread.subjectNorm, now)
      : db.prepare("UPDATE threads SET last_message_at = MAX(last_message_at, ?), message_count = message_count + 1 WHERE id = ?").bind(now, thread.id),
    db
      .prepare("UPDATE messages SET thread_id = ?, provider_message_id = ?, send_status = CASE WHEN send_status = 'queued' THEN 'sent' ELSE send_status END WHERE id = ?")
      .bind(thread.id, providerMessageId, id),
  ];
}

export async function suppressedAmong(db: D1Database, addresses: string[]): Promise<string[]> {
  if (!addresses.length) return [];
  const { results } = await db
    .prepare(`SELECT address FROM suppressions WHERE address IN (${addresses.map(() => "?").join(", ")})`)
    .bind(...addresses)
    .all<{ address: string }>();
  return results.map((r) => r.address);
}

// ---- Webhook ----

/** Idempotent: Resend may deliver the same event more than once, and in any order. */
export function deliveryStatements(db: D1Database, update: DeliveryUpdate, now: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE messages SET
           send_status = CASE
             WHEN ? IS NULL THEN send_status
             WHEN send_status IN ('bounced', 'complained') AND ? IN ('queued', 'sent', 'delivered') THEN send_status
             WHEN send_status = 'delivered' AND ? IN ('queued', 'sent') THEN send_status
             ELSE ? END,
           message_id_hdr = COALESCE(?, message_id_hdr)
         WHERE provider_message_id = ?`,
      )
      .bind(update.status, update.status, update.status, update.status, update.messageIdHeader, update.providerMessageId),
  ];
  for (const address of update.suppress?.addresses ?? []) {
    statements.push(
      db.prepare("INSERT OR IGNORE INTO suppressions (address, reason, created_at) VALUES (?, ?, ?)").bind(address.toLowerCase(), update.suppress!.reason, now),
    );
  }
  return statements;
}

