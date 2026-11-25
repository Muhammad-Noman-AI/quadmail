// Text helpers for building the search index in the browser. capUtf8 mirrors src/worker/inbound/text.ts.
import { SEARCH_TEXT_MAX_BYTES, SNIPPET_MAX_CHARS } from "../../shared/types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function capUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Rough HTML → text for snippets and search only (never rendered as HTML, so this is not a sanitiser).
 * Drops head/style/script blocks, turns block tags into spaces, strips the rest, decodes common entities.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16)) ?? match;
      if (lower.startsWith("#")) return safeCodePoint(parseInt(lower.slice(1), 10)) ?? match;
      return ENTITIES[lower] ?? match;
    });
}

function safeCodePoint(code: number): string | null {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function makeSnippet(text: string): string {
  const collapsed = collapseWhitespace(text);
  return collapsed.length <= SNIPPET_MAX_CHARS ? collapsed : collapsed.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd() + "…";
}

export function makeSearchText(text: string): string {
  return capUtf8(collapseWhitespace(text), SEARCH_TEXT_MAX_BYTES);
}
