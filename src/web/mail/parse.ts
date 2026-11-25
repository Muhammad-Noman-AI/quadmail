// CONTRACT, implemented by Track A (Phase 3). Track B (the reader UI) calls these.
import type { ParsedMessage } from "../../shared/types";

/** Parse a raw RFC 5322 message in the browser (postal-mime). Never throws on malformed input: returns what it can. */
export async function parseRaw(raw: ArrayBuffer): Promise<ParsedMessage> {
  void raw;
  throw new Error("parseRaw: implemented in Phase 3");
}

/**
 * Fetch /api/messages/:id/raw, parse it, upload attachments and post the index fields back
 * (POST /api/messages/:id/parsed). Returns the parsed message for immediate display.
 */
export async function indexMessage(id: string): Promise<ParsedMessage> {
  void id;
  throw new Error("indexMessage: implemented in Phase 3");
}

/** Index every message still in parse_status 'pending' (called once after login, in the background). */
export async function processPending(): Promise<void> {
  throw new Error("processPending: implemented in Phase 3");
}
