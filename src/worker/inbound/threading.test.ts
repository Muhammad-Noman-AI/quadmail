import { describe, expect, it } from "vitest";
import { pickSubjectThread, referenceLookupIds, SUBJECT_THREAD_WINDOW_MS } from "./threading";

describe("referenceLookupIds", () => {
  it("puts In-Reply-To first, then references newest first, de-duplicated", () => {
    expect(referenceLookupIds("<c>", ["<a>", "<b>", "<c>"])).toEqual(["<c>", "<b>", "<a>"]);
    expect(referenceLookupIds(null, [])).toEqual([]);
  });
  it("caps the number of ids (D1 bound parameter limit)", () => {
    const refs = Array.from({ length: 60 }, (_, i) => `<${i}>`);
    expect(referenceLookupIds(null, refs)).toHaveLength(20);
  });
});

describe("pickSubjectThread", () => {
  const now = 1_800_000_000_000;
  const candidates = [
    { threadId: "old", lastMessageAt: now - SUBJECT_THREAD_WINDOW_MS - 1, participants: ["alice@example.com"] },
    { threadId: "other-person", lastMessageAt: now - 1000, participants: ["mallory@example.com", "noman@quadgentics.com"] },
    { threadId: "match", lastMessageAt: now - 5000, participants: ["noman@quadgentics.com", "alice@example.com"] },
  ];

  it("picks the recent thread that shares the sender", () => {
    expect(pickSubjectThread("invoice", ["Alice@Example.com"], candidates, now)).toBe("match");
  });
  it("ignores threads outside the 30-day window", () => {
    expect(pickSubjectThread("invoice", ["alice@example.com"], [candidates[0]!], now)).toBeNull();
  });
  it("never groups empty subjects", () => {
    expect(pickSubjectThread("", ["alice@example.com"], candidates, now)).toBeNull();
  });
  it("does not group by subject alone when no participant is shared", () => {
    expect(pickSubjectThread("invoice", ["eve@example.com"], candidates, now)).toBeNull();
  });
});
