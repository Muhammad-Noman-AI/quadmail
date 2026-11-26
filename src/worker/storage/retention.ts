// Daily retention: Trash and Spam are emptied 30 days after a message was moved there.
// Also removes expired sessions and stale login counters. Bounded per run (CPU and subrequest limits).
export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Messages purged per run; the rest go the next day. */
export const PURGE_BATCH = 200;
const ID_CHUNK = 90;

export interface PurgeResult {
  messages: number;
  objects: number;
}

export function retentionCutoff(now: number): number {
  return now - RETENTION_DAYS * DAY_MS;
}

export async function purgeExpired(db: D1Database, bucket: R2Bucket, now: number): Promise<PurgeResult> {
  const { results: rows } = await db
    .prepare(
      `SELECT id, raw_key, html_key FROM messages
       WHERE folder IN ('trash', 'spam') AND COALESCE(folder_changed_at, received_at) < ?
       ORDER BY COALESCE(folder_changed_at, received_at) LIMIT ?`,
    )
    .bind(retentionCutoff(now), PURGE_BATCH)
    .all<{ id: string; raw_key: string | null; html_key: string | null }>();

  const keys = rows.flatMap((row) => [row.raw_key, row.html_key].filter((key): key is string => !!key));
  const ids = rows.map((row) => row.id);
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { results } = await db
      .prepare(`SELECT r2_key FROM attachments WHERE message_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ r2_key: string }>();
    for (const { r2_key } of results) keys.push(r2_key, `${r2_key}.b64`);
  }

  // R2 first: if the D1 delete then fails, the rows stay and the next run retries. The other order
  // would leave raw objects without rows, which the reconcile job would bring back into the inbox.
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    // Attachments and labels go with the message (ON DELETE CASCADE); the FTS row via trigger.
    statements.push(db.prepare(`DELETE FROM messages WHERE id IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk));
  }
  statements.push(
    db.prepare("DELETE FROM threads WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)"),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM login_attempts WHERE window_start < ?").bind(now - DAY_MS),
  );
  await db.batch(statements);
  return { messages: ids.length, objects: keys.length };
}
