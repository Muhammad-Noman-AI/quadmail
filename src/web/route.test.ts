import { describe, expect, it } from "vitest";
import { parseHash, viewHash } from "./route";

const ID = "01KQX2Y3Z4ABCDEFGHJKMNPQRS";

describe("hash routing", () => {
  it("parses folders, messages, labels and searches", () => {
    expect(parseHash("")).toEqual({ view: { kind: "folder", folder: "inbox" }, messageId: null });
    expect(parseHash(`#/archive/${ID}`)).toEqual({ view: { kind: "folder", folder: "archive" }, messageId: ID });
    expect(parseHash(`#/label/${ID}`)).toEqual({ view: { kind: "label", labelId: ID }, messageId: null });
    expect(parseHash("#/search/from%3Aalice%20invoice")).toEqual({ view: { kind: "search", query: "from:alice invoice" }, messageId: null });
    expect(parseHash("#/nonsense/<script>")).toEqual({ view: { kind: "folder", folder: "inbox" }, messageId: null });
  });

  it("round-trips", () => {
    const route = { view: { kind: "search" as const, query: "has:attachment a/b" }, messageId: ID };
    expect(parseHash(viewHash(route.view, route.messageId))).toEqual(route);
  });
});
