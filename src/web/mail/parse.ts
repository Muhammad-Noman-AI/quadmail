// Browser-side MIME parsing (Track A). The Worker never parses bodies: it would blow the 10 ms CPU limit.
import PostalMime, { type Address as PostalAddress, type Attachment as PostalAttachment } from "postal-mime";
import type { Address, ParsedMessage } from "../../shared/types";
import { htmlToText, makeSearchText, makeSnippet } from "./text";

export interface ParseOutcome {
  parsed: ParsedMessage;
  /** Set when postal-mime failed; `parsed` then holds a best-effort plain-text view of the raw bytes. */
  error: string | null;
}

function toAddresses(list: PostalAddress[] | PostalAddress | undefined): Address[] {
  const items = Array.isArray(list) ? list : list ? [list] : [];
  const result: Address[] = [];
  for (const item of items) {
    const mailboxes = item.group ?? [item];
    for (const mailbox of mailboxes) {
      if (!mailbox.address) continue;
      const address = mailbox.address.toLowerCase();
      result.push(mailbox.name ? { address, name: mailbox.name } : { address });
    }
  }
  return result;
}

function toArrayBuffer(content: PostalAttachment["content"]): ArrayBuffer {
  if (typeof content === "string") return new TextEncoder().encode(content).buffer as ArrayBuffer;
  if (content instanceof ArrayBuffer) return content;
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}

function stripAngle(value: string | undefined): string | null {
  return value ? value.replace(/^<|>$/g, "") : null;
}

export async function parseRawDetailed(raw: ArrayBuffer): Promise<ParseOutcome> {
  try {
    const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
    const bodyText = email.text ?? (email.html ? htmlToText(email.html) : "");
    const attachments = email.attachments.map((attachment, index) => {
      const content = toArrayBuffer(attachment.content);
      return {
        id: `att-${index}`,
        filename: attachment.filename,
        contentType: attachment.mimeType || null,
        sizeBytes: content.byteLength,
        contentId: stripAngle(attachment.contentId),
        isInline: attachment.disposition === "inline" || (attachment.related === true && !!attachment.contentId),
        content,
      };
    });
    const names = attachments.map((a) => a.filename ?? "").join(" ");
    return {
      parsed: {
        from: toAddresses(email.from)[0] ?? null,
        to: toAddresses(email.to),
        cc: toAddresses(email.cc),
        subject: email.subject ?? null,
        html: email.html ?? null,
        text: email.text ?? null,
        snippet: makeSnippet(bodyText),
        searchText: makeSearchText(`${bodyText} ${names}`),
        attachments,
      },
      error: null,
    };
  } catch (err) {
    // Malformed beyond what postal-mime tolerates: show the bytes as text rather than nothing.
    const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    return {
      parsed: { from: null, to: [], cc: [], subject: null, html: null, text, snippet: makeSnippet(text), searchText: makeSearchText(text), attachments: [] },
      error: err instanceof Error ? err.message : "Could not parse message",
    };
  }
}

/** Parse a raw RFC 5322 message in the browser (postal-mime). Never throws on malformed input: returns what it can. */
export async function parseRaw(raw: ArrayBuffer): Promise<ParsedMessage> {
  return (await parseRawDetailed(raw)).parsed;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status}`);
  return response;
}

function postJson(path: string, body: unknown): Promise<Response> {
  return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Fired on window after a message is indexed, so open lists can show its snippet without a reload. */
export const INDEXED_EVENT = "qm:indexed";

export interface IndexedDetail {
  id: string;
  from: ParsedMessage["from"];
  subject: string | null;
  snippet: string;
  hasAttachments: boolean;
}

/**
 * Fetch /api/messages/:id/raw, parse it, upload attachments and post the index fields back
 * (POST /api/messages/:id/parsed). Returns the parsed message for immediate display.
 */
export async function indexMessage(id: string): Promise<ParsedMessage> {
  const base = `/api/messages/${encodeURIComponent(id)}`;
  const raw = await (await request(`${base}/raw`)).arrayBuffer();
  const { parsed: local, error } = await parseRawDetailed(raw);
  // Server-side attachment IDs must be unique and stable across re-parses (uploads are idempotent).
  const parsed: ParsedMessage = { ...local, attachments: local.attachments.map((a, index) => ({ ...a, id: `${id}-${index}` })) };

  if (error) {
    await postJson(`${base}/parse-failed`, { error }).catch(() => undefined);
    return parsed;
  }
  try {
    for (const attachment of parsed.attachments) {
      const headers: Record<string, string> = {
        "content-type": attachment.contentType ?? "application/octet-stream",
        "x-inline": attachment.isInline ? "1" : "0",
      };
      if (attachment.filename) headers["x-filename"] = encodeURIComponent(attachment.filename);
      if (attachment.contentId) headers["x-content-id"] = attachment.contentId;
      await request(`${base}/attachments/${encodeURIComponent(attachment.id)}`, { method: "PUT", headers, body: attachment.content });
    }
    await postJson(`${base}/parsed`, {
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      snippet: parsed.snippet,
      searchText: parsed.searchText,
      attachments: parsed.attachments.map(({ content, ...meta }) => {
        void content;
        return meta;
      }),
    });
  } catch (err) {
    await postJson(`${base}/parse-failed`, { error: err instanceof Error ? err.message : "Indexing failed" }).catch(() => undefined);
    throw err;
  }
  const detail: IndexedDetail = { id, from: parsed.from, subject: parsed.subject, snippet: parsed.snippet, hasAttachments: parsed.attachments.some((a) => !a.isInline) };
  window.dispatchEvent(new CustomEvent<IndexedDetail>(INDEXED_EVENT, { detail }));
  return parsed;
}

const PENDING_BATCH = 10;
const MAX_PER_RUN = 200;

/** Index every message still in parse_status 'pending' (called once after login, in the background). */
export async function processPending(): Promise<void> {
  const attempted = new Set<string>();
  while (attempted.size < MAX_PER_RUN) {
    const { ids } = (await (await request(`/api/inbound/pending?limit=${PENDING_BATCH}`)).json()) as { ids: string[] };
    const fresh = ids.filter((id) => !attempted.has(id));
    // Stop when nothing new comes back (e.g. a message whose failure could not be recorded).
    if (fresh.length === 0) return;
    for (const id of fresh) {
      attempted.add(id);
      await indexMessage(id).catch(() => undefined);
    }
  }
}
