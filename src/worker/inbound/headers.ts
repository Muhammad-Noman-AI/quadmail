// Cheap header extraction for the email() handler. Headers only: the body is never parsed in the Worker.
import { addressParser, decodeWords } from "postal-mime";
import type { Address } from "../../shared/types";

const MAX_HEADER_CHARS = 4000;
const MAX_REFERENCES = 50;
const MAX_ADDRESSES = 100;

/** Decode RFC 2047 encoded-words (=?utf-8?B?...?=). Falls back to the raw value on bad input. */
export function decodeHeader(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.slice(0, MAX_HEADER_CHARS).trim();
  if (!trimmed) return null;
  try {
    return decodeWords(trimmed).trim();
  } catch {
    return trimmed;
  }
}

/** Parse an address-list header (To, Cc, From) into plain mailboxes; groups are flattened. */
export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  let parsed: ReturnType<typeof addressParser>;
  try {
    parsed = addressParser(value.slice(0, MAX_HEADER_CHARS), { flatten: true });
  } catch {
    return [];
  }
  const result: Address[] = [];
  for (const entry of parsed) {
    if (!entry.address) continue;
    const name = decodeHeader(entry.name) ?? undefined;
    result.push(name ? { address: entry.address.toLowerCase(), name } : { address: entry.address.toLowerCase() });
    if (result.length >= MAX_ADDRESSES) break;
  }
  return result;
}

/** All `<...>` message IDs in a header value (Message-ID, In-Reply-To, References), angle brackets kept. */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.slice(0, MAX_HEADER_CHARS * 4).match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids)].slice(-MAX_REFERENCES);
}

/** Subject used for thread grouping: no Re:/Fwd:/Aw: prefixes or [list] tags, lower case, single spaces. */
export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  let s = subject.toLowerCase().replace(/\s+/g, " ").trim();
  const prefix = /^(?:(?:re|fw|fwd|aw|wg|sv|vs|antw|tr)(?:\[\d+\])?\s*:|\[[^\]]{1,40}\])\s*/;
  for (let i = 0; i < 10 && prefix.test(s); i++) s = s.replace(prefix, "");
  return s.trim();
}

export interface InboundHeaders {
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address | null;
  to: Address[];
  cc: Address[];
  authResults: string | null;
}

export function extractInboundHeaders(headers: Headers): InboundHeaders {
  const inReplyTo = parseMessageIds(headers.get("in-reply-to"))[0] ?? null;
  return {
    subject: decodeHeader(headers.get("subject")),
    messageId: parseMessageIds(headers.get("message-id"))[0] ?? null,
    inReplyTo,
    references: parseMessageIds(headers.get("references")),
    from: parseAddressList(headers.get("from"))[0] ?? null,
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    authResults: headers.get("authentication-results")?.slice(0, MAX_HEADER_CHARS) ?? null,
  };
}
