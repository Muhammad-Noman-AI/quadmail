import { describe, expect, it } from "vitest";
import { SEARCH_TEXT_MAX_BYTES, SNIPPET_MAX_CHARS } from "../../shared/types";
import { parseRaw, parseRawDetailed } from "./parse";
import { capUtf8, htmlToText, makeSearchText, makeSnippet } from "./text";
import htmlEml from "../../../test/fixtures/html-attachments.eml?raw";
import plainEml from "../../../test/fixtures/plain.eml?raw";
import malformedEml from "../../../test/fixtures/malformed.eml?raw";
import replyEml from "../../../test/fixtures/reply.eml?raw";

const fixtures: Record<string, string> = {
  "plain.eml": plainEml,
  "html-attachments.eml": htmlEml,
  "reply.eml": replyEml,
  "malformed.eml": malformedEml,
};

function fixture(name: string): ArrayBuffer {
  if (name === "garbage") {
    const bytes = new Uint8Array(3000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24; // deterministic noise
    return bytes.buffer;
  }
  return new TextEncoder().encode(fixtures[name]).buffer as ArrayBuffer;
}

describe("parseRaw", () => {
  it("parses a plain-text message with an encoded subject", async () => {
    const parsed = await parseRaw(fixture("plain.eml"));
    expect(parsed.subject).toBe("Hello été");
    expect(parsed.from).toEqual({ address: "alice@example.com", name: "Alice Example" });
    expect(parsed.to).toEqual([{ address: "noman@quadgentics.com" }]);
    expect(parsed.snippet).toBe("Hi Noman, This is a plain text message.");
    expect(parsed.attachments).toEqual([]);
  });

  it("extracts HTML text, inline images and attachments", async () => {
    const parsed = await parseRaw(fixture("html-attachments.eml"));
    expect(parsed.html).toContain("cid:logo123");
    expect(parsed.snippet).toBe("Quarterly & yearly numbers");
    expect(parsed.cc).toEqual([{ address: "carol@example.net" }]);
    expect(parsed.to.map((a) => a.address)).toEqual(["noman@quadgentics.com", "team@quadgentics.com"]);
    const [logo, report] = parsed.attachments;
    expect(logo).toMatchObject({ filename: "logo.png", contentType: "image/png", contentId: "logo123", isInline: true });
    expect(report).toMatchObject({ filename: "report.pdf", contentType: "application/pdf", isInline: false });
    expect(report!.sizeBytes).toBe(report!.content.byteLength);
    expect(new TextDecoder().decode(report!.content)).toBe("%PDF-1.4\n");
    expect(parsed.searchText).toContain("report.pdf");
  });

  it("parses a reply", async () => {
    const parsed = await parseRaw(fixture("reply.eml"));
    expect(parsed.subject).toBe("Re: Hello");
    expect(parsed.text?.trim()).toBe("Thanks!");
  });

  it("never throws on garbage input", async () => {
    const outcome = await parseRawDetailed(fixture("garbage"));
    expect(outcome.parsed.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(new TextEncoder().encode(outcome.parsed.searchText).byteLength).toBeLessThanOrEqual(SEARCH_TEXT_MAX_BYTES);
    await expect(parseRaw(new ArrayBuffer(0))).resolves.toBeDefined();
  });

  it("survives broken MIME (unclosed boundary, bad base64, bad encoded-word)", async () => {
    const parsed = await parseRaw(fixture("malformed.eml"));
    expect(parsed.from).toEqual({ address: "weird@example.com", name: "Weird" });
    expect(typeof parsed.snippet).toBe("string");
  });
});

describe("text helpers", () => {
  it("caps UTF-8 by bytes without splitting characters", () => {
    expect(capUtf8("héllo", 2)).toBe("h");
    expect(capUtf8("héllo", 3)).toBe("hé");
    expect(capUtf8("😀😀", 5)).toBe("😀");
    expect(capUtf8("short", 100)).toBe("short");
  });
  it("caps search text at 8 KB", () => {
    const text = makeSearchText("é".repeat(10_000));
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(SEARCH_TEXT_MAX_BYTES);
  });
  it("builds snippets with collapsed whitespace and an ellipsis", () => {
    expect(makeSnippet("  a \n\n b  ")).toBe("a b");
    const long = makeSnippet("word ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
  it("turns HTML into text, dropping style and script", () => {
    expect(htmlToText("<style>x{}</style><script>alert(1)</script><p>A&nbsp;&#233;&#x41;</p>").trim()).toBe("A éA");
  });
});
