// HTML written in the composer: a small, safe subset, plus its plain-text alternative.
import DOMPurify from "dompurify";
import { escapeHtml } from "../reader/sanitize";
import { htmlToText } from "../mail/text";

const ALLOWED_TAGS = ["a", "b", "strong", "i", "em", "u", "s", "p", "br", "div", "span", "ul", "ol", "li", "blockquote", "pre", "code", "hr"];

/** What leaves the composer: formatting tags and http(s)/mailto links only. No styles, images or scripts. */
export function sanitizeComposeHtml(html: string): string {
  return DOMPurify(window).sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/** Plain-text alternative sent with every message (and used for the snippet and search index). */
export function composeText(html: string): string {
  return htmlToText(html.replace(/<blockquote\b[^>]*>/gi, "\n").replace(/<\/blockquote>/gi, "\n"))
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
