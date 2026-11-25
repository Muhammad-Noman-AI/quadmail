// Pure threading decisions. Storage lookups live in storage/inbound.ts.

export const SUBJECT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Message IDs to look up, most specific first: In-Reply-To, then References newest to oldest. */
export function referenceLookupIds(inReplyTo: string | null, references: string[], limit = 20): string[] {
  const ordered = [...(inReplyTo ? [inReplyTo] : []), ...[...references].reverse()];
  return [...new Set(ordered)].slice(0, limit);
}

export interface SubjectCandidate {
  threadId: string;
  lastMessageAt: number;
  /** Lower-cased addresses seen in that thread (from, to, envelope). */
  participants: string[];
}

/**
 * Pick an existing thread with the same normalised subject that shares a participant and had
 * activity within the window. Empty subjects never group, so unrelated "(no subject)" mail stays apart.
 */
export function pickSubjectThread(
  subjectNorm: string,
  participants: string[],
  candidates: SubjectCandidate[],
  now: number,
): string | null {
  if (!subjectNorm) return null;
  const mine = new Set(participants.map((p) => p.toLowerCase()));
  let best: SubjectCandidate | null = null;
  for (const candidate of candidates) {
    if (now - candidate.lastMessageAt > SUBJECT_THREAD_WINDOW_MS) continue;
    if (!candidate.participants.some((p) => mine.has(p.toLowerCase()))) continue;
    if (!best || candidate.lastMessageAt > best.lastMessageAt) best = candidate;
  }
  return best?.threadId ?? null;
}
