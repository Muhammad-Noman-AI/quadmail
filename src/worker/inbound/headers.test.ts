import { describe, expect, it } from "vitest";
import { decodeHeader, extractInboundHeaders, normalizeSubject, parseAddressList, parseMessageIds } from "./headers";

describe("decodeHeader", () => {
  it("decodes RFC 2047 base64 and quoted-printable words", () => {
    expect(decodeHeader("=?UTF-8?B?SGVsbG8gw6l0w6k=?=")).toBe("Hello été");
    expect(decodeHeader("=?iso-8859-1?Q?caf=E9?= time")).toBe("café time");
  });
  it("passes plain text through and treats blank as null", () => {
    expect(decodeHeader("Plain subject")).toBe("Plain subject");
    expect(decodeHeader("   ")).toBeNull();
    expect(decodeHeader(null)).toBeNull();
  });
});

describe("parseAddressList", () => {
  it("parses names, lower-cases addresses and flattens groups", () => {
    expect(parseAddressList('"Bob B" <Bob@Example.org>, carol@example.net, Team: dan@x.io;')).toEqual([
      { address: "bob@example.org", name: "Bob B" },
      { address: "carol@example.net" },
      { address: "dan@x.io" },
    ]);
  });
  it("decodes encoded display names", () => {
    expect(parseAddressList("=?UTF-8?B?w4lsaXNl?= <elise@example.fr>")).toEqual([{ address: "elise@example.fr", name: "Élise" }]);
  });
  it("returns [] for empty or junk input", () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList("not an address")).toEqual([]);
  });
});

describe("parseMessageIds", () => {
  it("extracts and de-duplicates angle-bracket ids", () => {
    expect(parseMessageIds("<a@x> <b@y>\r\n <a@x>")).toEqual(["<a@x>", "<b@y>"]);
    expect(parseMessageIds("garbage")).toEqual([]);
  });
});

describe("normalizeSubject", () => {
  it("strips reply/forward prefixes, list tags, case and spacing", () => {
    expect(normalizeSubject("Re: RE: Fwd:  Hello   World")).toBe("hello world");
    expect(normalizeSubject("AW: [team] Re[2]: Budget")).toBe("budget");
    expect(normalizeSubject("Return of the king")).toBe("return of the king");
    expect(normalizeSubject(null)).toBe("");
  });
});

describe("extractInboundHeaders", () => {
  it("reads only the headers the handler needs", () => {
    const headers = new Headers({
      subject: "=?UTF-8?Q?Re:_Caf=C3=A9?=",
      "message-id": "<m1@x>",
      "in-reply-to": "<m0@x>",
      references: "<root@x> <m0@x>",
      from: "Alice <ALICE@example.com>",
      to: "noman@quadgentics.com",
      "authentication-results": "mx.cloudflare.net; spf=pass",
    });
    expect(extractInboundHeaders(headers)).toEqual({
      subject: "Re: Café",
      messageId: "<m1@x>",
      inReplyTo: "<m0@x>",
      references: ["<root@x>", "<m0@x>"],
      from: { address: "alice@example.com", name: "Alice" },
      to: [{ address: "noman@quadgentics.com" }],
      cc: [],
      authResults: "mx.cloudflare.net; spf=pass",
    });
  });
});
