import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, ftsExpression, parseSearch } from "./mail";

describe("parseSearch", () => {
  it("splits filters from free text", () => {
    expect(parseSearch('invoice from:alice@example.com has:attachment after:2026-01-01 in:archive "quarterly report"')).toEqual({
      terms: ["invoice", "quarterly report"],
      from: "alice@example.com",
      hasAttachment: true,
      after: Date.parse("2026-01-01T00:00:00Z"),
      folder: "archive",
    });
  });

  it("keeps unknown or invalid filters as text and ignores bad dates", () => {
    expect(parseSearch("before:notadate in:nowhere subject:x")).toEqual({ terms: ["in:nowhere", "subject:x"] });
  });

  it("supports quoted filter values", () => {
    expect(parseSearch('from:"Alice Smith"').from).toBe("Alice Smith");
  });
});

describe("ftsExpression", () => {
  it("quotes every term so FTS5 operators cannot be injected", () => {
    expect(ftsExpression(["hello", 'a"b', "OR", "NEAR(x"])).toBe('"hello"* "a""b"* "OR"* "NEAR(x"*');
    expect(ftsExpression(["  "])).toBeNull();
  });
});

describe("cursor", () => {
  it("round-trips and rejects junk", () => {
    const cursor = encodeCursor({ received_at: 1_795_000_000_000, id: "01KQX2Y3Z4ABCDEFGHJKMNPQRS" });
    expect(decodeCursor(cursor)).toEqual({ receivedAt: 1_795_000_000_000, id: "01KQX2Y3Z4ABCDEFGHJKMNPQRS" });
    expect(decodeCursor("!!!")).toBeNull();
    expect(decodeCursor(btoa("1:'; DROP TABLE messages;--"))).toBeNull();
  });
});
