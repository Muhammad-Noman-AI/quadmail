// Email HTML is hostile. Defence in depth:
//  1. DOMPurify with a strict HTML-only profile and extra forbidden tags/attributes.
//  2. Our hooks: remote images/CSS removed unless the user allows them, cid: images inlined as
//     data: URLs, links forced to open in a new tab without referrer or opener.
//  3. The result is rendered in <iframe sandbox> (no scripts, opaque origin) whose own CSP meta
//     only allows data: images unless remote content was allowed. Even if a CSS trick slipped past
//     step 2, the browser would refuse to load it.
import DOMPurify from "dompurify";
import type { AttachmentMeta } from "../../shared/types";

export interface SanitizeOptions {
  /** Load remote images and CSS resources (user clicked "Load images"). */
  allowRemote: boolean;
  /** content-id (without angle brackets, lower-case) -> data: URL */
  inlineImages: Map<string, string>;
}

export interface SanitizeResult {
  html: string;
  /** Number of remote resources that were blocked. 0 when allowRemote is true. */
  blockedRemote: number;
}

const FORBID_TAGS = [
  "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
  "form", "input", "button", "textarea", "select", "option", "optgroup", "datalist", "output", "fieldset", "label",
  "base", "meta", "link", "audio", "video", "source", "track", "dialog", "math", "svg",
];
const FORBID_ATTR = ["srcdoc", "formaction", "action", "ping", "autofocus", "http-equiv", "srcset", "poster", "usemap"];
const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i;
const REMOTE = /^https?:\/\//i;
const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

type Decision = { value: string | null; blocked: boolean };

function resolveResource(raw: string, options: SanitizeOptions): Decision {
  const value = raw.trim();
  if (SAFE_DATA_IMAGE.test(value)) return { value, blocked: false };
  if (/^cid:/i.test(value)) {
    const id = value.slice(4).replace(/^<|>$/g, "").toLowerCase();
    return { value: options.inlineImages.get(id) ?? null, blocked: false };
  }
  if (REMOTE.test(value) || value.startsWith("//")) {
    return options.allowRemote ? { value: value.startsWith("//") ? `https:${value}` : value, blocked: false } : { value: null, blocked: true };
  }
  return { value: null, blocked: false }; // javascript:, vbscript:, data:text/html, relative paths, ...
}

/** Decode CSS escapes and drop comments so `u\72l(` or `@im/**\/port` cannot hide from the filters below. */
function normaliseCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\\(.)/g, "$1");
}

export function sanitizeCss(css: string, options: SanitizeOptions, counter: { blocked: number }): string {
  return normaliseCss(css)
    .replace(/@import[^;]*;?/gi, "")
    .replace(/(expression|behavior|-moz-binding|javascript:)/gi, "")
    .replace(/(?:-webkit-)?image-set\([^)]*\)/gi, () => {
      if (!options.allowRemote) counter.blocked++;
      return "none";
    })
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, _quote: string, target: string) => {
      const decision = resolveResource(target, options);
      if (decision.blocked) counter.blocked++;
      return decision.value ? `url("${decision.value.replace(/["\\\n\r]/g, "")}")` : "none";
    });
}

export function sanitizeEmailHtml(html: string, options: SanitizeOptions): SanitizeResult {
  const purify = DOMPurify(window);
  const counter = { blocked: 0 };

  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent) node.textContent = sanitizeCss(node.textContent, options, counter);
  });

  purify.addHook("afterSanitizeAttributes", (node) => {
    const element = node as Element;
    if (!element.getAttribute) return;

    const style = element.getAttribute("style");
    if (style) element.setAttribute("style", sanitizeCss(style, options, counter));

    for (const attr of ["src", "background"]) {
      const value = element.getAttribute(attr);
      if (value === null) continue;
      const decision = resolveResource(value, options);
      if (decision.blocked) counter.blocked++;
      if (decision.value) element.setAttribute(attr, decision.value);
      else element.removeAttribute(attr);
    }

    const tag = element.tagName.toLowerCase();
    if (tag === "a" || tag === "area") {
      const href = element.getAttribute("href");
      if (href && !SAFE_LINK.test(href.trim())) element.removeAttribute("href");
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  });

  const clean = purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_ATTR: ["target"],
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true, // keep leading <style> blocks instead of dropping them with <head>
  }) as string;

  return { html: clean, blockedRemote: options.allowRemote ? 0 : counter.blocked };
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Plain-text body: escaped, with http(s) links made clickable. */
export function plainTextToHtml(text: string): string {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  const body = parts
    .map((part, index) => {
      if (index % 2 === 0) return escapeHtml(part);
      const url = part.replace(/[.,;:!?)]+$/, "");
      const tail = part.slice(url.length);
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(tail)}`;
    })
    .join("");
  return `<div style="white-space:pre-wrap;font-family:inherit">${body}</div>`;
}

/** Wrap sanitised body HTML in a complete document for the sandboxed iframe's srcdoc. */
export function frameDocument(bodyHtml: string, allowRemote: boolean, dark = false): string {
  const remote = allowRemote ? " https: http:" : "";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${remote}; font-src data:${remote}; form-action 'none'; base-uri 'none'`;
  const colors = dark ? "color:#e5e5e5;background:#171717" : "color:#171717;background:#ffffff";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0}body{padding:16px;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;${colors};overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}</style></head><body>${bodyHtml}</body></html>`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** content-id -> data: URL for inline image attachments (cid: references in the HTML). */
export function inlineImageMap(attachments: Array<AttachmentMeta & { content: ArrayBuffer }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const attachment of attachments) {
    const type = (attachment.contentType ?? "").toLowerCase();
    if (!attachment.contentId || !/^image\/(png|gif|jpe?g|webp|bmp|avif)$/.test(type)) continue;
    map.set(attachment.contentId.replace(/^<|>$/g, "").toLowerCase(), `data:${type};base64,${bytesToBase64(new Uint8Array(attachment.content))}`);
  }
  return map;
}
