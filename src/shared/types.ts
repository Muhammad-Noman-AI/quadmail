// Contracts shared by the Worker and the web app. Both tracks depend on these: change with care.

export type Folder = "inbox" | "sent" | "drafts" | "archive" | "spam" | "trash";
export const FOLDERS: readonly Folder[] = ["inbox", "sent", "drafts", "archive", "spam", "trash"];

export interface Address {
  address: string;
  name?: string;
}

/** One row in a message list. */
export interface MessageSummary {
  id: string;
  threadId: string | null;
  folder: Folder;
  direction: "in" | "out";
  from: Address | null;
  to: Address[];
  subject: string | null;
  snippet: string | null;
  receivedAt: number;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  parseStatus: "pending" | "done" | "failed";
  labelIds: string[];
}

export interface AttachmentMeta {
  id: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number;
  contentId: string | null;
  isInline: boolean;
}

/** Full message for the reader. The body comes from the raw .eml (GET /api/messages/:id/raw). */
export interface MessageDetail extends MessageSummary {
  cc: Address[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  authResults: string | null;
  attachments: AttachmentMeta[];
}

/**
 * What the browser extracts from a raw .eml with postal-mime (src/web/mail/parse.ts, Track A).
 * The index fields are posted to POST /api/messages/:id/parsed.
 * `html` is UNSANITISED: rendering code (Track B) must sanitise it before display.
 */
export interface ParsedMessage {
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string | null;
  html: string | null;
  text: string | null;
  snippet: string;
  /** Plain text for full-text search, at most SEARCH_TEXT_MAX_BYTES of UTF-8. */
  searchText: string;
  attachments: Array<AttachmentMeta & { content: ArrayBuffer }>;
}

export const SEARCH_TEXT_MAX_BYTES = 8 * 1024;
export const SNIPPET_MAX_CHARS = 200;
