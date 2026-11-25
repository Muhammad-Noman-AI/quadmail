// Load a message's displayable content, wherever its body lives.
import type { MessageDetail, ParsedMessage, StoredBody } from "../../shared/types";
import { indexMessage, parseRaw } from "./parse";
import { htmlToText, makeSnippet } from "./text";

export async function loadContent(message: MessageDetail): Promise<ParsedMessage> {
  if (message.bodySource === "body") {
    // Mail written in QuadMail: body JSON in R2; attachments are listed in message.attachments.
    const response = await fetch(`/api/messages/${message.id}/body`, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Could not load the message (${response.status})`);
    const body = (await response.json()) as StoredBody;
    const text = body.text || htmlToText(body.html);
    return { from: message.from, to: message.to, cc: message.cc, subject: message.subject, html: body.html || null, text, snippet: makeSnippet(text), searchText: "", attachments: [] };
  }
  if (message.parseStatus !== "done") return indexMessage(message.id);
  const response = await fetch(`/api/messages/${message.id}/raw`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Could not load the message (${response.status})`);
  return parseRaw(await response.arrayBuffer());
}
