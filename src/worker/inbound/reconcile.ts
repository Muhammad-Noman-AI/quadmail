// Daily reconcile: find raw .eml objects in R2 that have no D1 row (the D1 insert failed after the
// R2 write succeeded) and add minimal 'pending' rows. The browser parse fills in the rest.
// Only the current and previous month are scanned: lost rows can only come from recent deliveries,
// and this keeps R2 list operations (Class A) and Worker CPU small.
import { ulidTime } from "../../shared/ulid";
import { existingIds, getJobState, idFromRawKey, reconcileInsert, setJobState } from "../storage/inbound";

const PAGE_SIZE = 500;
const MAX_PAGES_PER_RUN = 4;

export function monthPrefixes(now: number): string[] {
  const d = new Date(now);
  const current = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const previous = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const prefix = (date: Date) => `raw/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/`;
  return [prefix(previous), prefix(current)];
}

export async function reconcileRaw(env: Env, now = Date.now()): Promise<{ scanned: number; inserted: number }> {
  let scanned = 0;
  let inserted = 0;
  let pages = 0;
  for (const prefix of monthPrefixes(now)) {
    const stateKey = `reconcile:${prefix}`;
    let cursor = (await getJobState(env.DB, stateKey)) ?? undefined;
    while (pages < MAX_PAGES_PER_RUN) {
      pages++;
      const listing = await env.MAIL.list({ prefix, cursor, limit: PAGE_SIZE, include: ["customMetadata"] });
      const objects = listing.objects.flatMap((object) => {
        const id = idFromRawKey(object.key);
        return id ? [{ id, object }] : [];
      });
      scanned += objects.length;
      const known = await existingIds(env.DB, objects.map((o) => o.id));
      const missing = objects.filter((o) => !known.has(o.id));
      if (missing.length > 0) {
        await env.DB.batch(
          missing.map(({ id, object }) =>
            reconcileInsert(env.DB, {
              id,
              rawKey: object.key,
              sizeBytes: object.size,
              receivedAt: ulidTime(id),
              envelopeFrom: object.customMetadata?.envelopeFrom?.toLowerCase() ?? null,
              envelopeTo: object.customMetadata?.envelopeTo?.toLowerCase() ?? null,
            }),
          ),
        );
        inserted += missing.length;
      }
      cursor = listing.truncated ? listing.cursor : undefined;
      if (!cursor) break;
    }
    // Resume next run where this one stopped; a finished prefix starts over from the beginning.
    await setJobState(env.DB, stateKey, cursor ?? null);
    if (pages >= MAX_PAGES_PER_RUN) break;
  }
  if (inserted > 0) console.log("reconcile: indexed missing messages", inserted);
  return { scanned, inserted };
}
