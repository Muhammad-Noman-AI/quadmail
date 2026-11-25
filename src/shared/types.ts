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
  /** Outgoing mail only: delivery state reported by the provider. */
  sendStatus: SendStatus | null;
}

export type SendStatus = "queued" | "sent" | "delivered" | "bounced" | "complained" | "failed";

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
  bcc: Address[];
  /** Where the body lives: the raw .eml (received mail) or a stored body JSON (mail written here). */
  bodySource: "raw" | "body";
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

/** Body of mail written in QuadMail (drafts and sent), stored in R2 as JSON. */
export interface StoredBody {
  html: string;
  text: string;
}

/** What the composer saves. Addresses are already parsed by the browser and re-validated by the Worker. */
export interface DraftInput extends StoredBody {
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
}

export interface Identity {
  id: string;
  address: string;
  displayName: string | null;
  signatureHtml: string | null;
  isDefault: boolean;
}

export interface SendingInfo {
  identities: Identity[];
  sentToday: number;
  dailyLimit: number;
  maxRecipients: number;
  maxAttachmentBytes: number;
  allowedDomains: string[];
  /** False until RESEND_API_KEY is configured. */
  providerReady: boolean;
}

/** Fixed send rules (master prompt section 9). Every To, Cc and Bcc address counts against the daily limit. */
export const MAX_RECIPIENTS = 20;
/** Total attachment bytes per outgoing message. Base64 makes it ~13.4 MB, under Resend's 40 MB. */
export const MAX_OUTGOING_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_BODY_HTML_CHARS = 512 * 1024;
