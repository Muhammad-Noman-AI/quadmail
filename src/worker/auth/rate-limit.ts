// Login throttling backed by the login_attempts table: MAX_FAILURES per WINDOW_MS, per key.
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;

export function attemptKeys(ip: string, email: string): string[] {
  return [`ip:${ip}`, `user:${email.trim().toLowerCase()}`];
}

/** True if any key has reached the failure limit inside the current window. */
export async function isLimited(db: D1Database, keys: string[], now = Date.now()): Promise<boolean> {
  const placeholders = keys.map(() => "?").join(", ");
  const row = await db
    .prepare(`SELECT MAX(count) AS worst FROM login_attempts WHERE key IN (${placeholders}) AND window_start > ?`)
    .bind(...keys, now - WINDOW_MS)
    .first<{ worst: number | null }>();
  return (row?.worst ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(db: D1Database, keys: string[], now = Date.now()): Promise<void> {
  // New window if the old one expired; otherwise count up.
  const stmt = db.prepare(
    `INSERT INTO login_attempts (key, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END`,
  );
  await db.batch(keys.map((key) => stmt.bind(key, now, now - WINDOW_MS, now - WINDOW_MS)));
}

/** A successful login clears the account counter (not the IP counter, so one IP cannot reset others). */
export async function clearAccount(db: D1Database, email: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(`user:${email.trim().toLowerCase()}`).run();
}
