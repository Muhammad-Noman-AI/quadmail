// Initial composer state for new mail, replies and forwards. Pure functions over loaded data.
import type { Address, AttachmentMeta, Identity, MessageDetail, ParsedMessage } from "../../shared/types";
import { displayAddress, longDate } from "../format";
import { escapeHtml } from "../reader/sanitize";
import { textToHtml } from "./html";

export type ReplyMode = "reply" | "replyAll" | "forward";

export interface ComposeInit {
  from?: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  replyToId?: string;
  /** Attachments of the original, copied into the draft when forwarding. */
  forwardAttachments?: AttachmentMeta[];
}


export function prefixSubject(prefix: "Re" | "Fwd", subject: string | null): string {
  const clean = (subject ?? "").trim();
  const already = prefix === "Re" ? /^re:/i : /^(fwd?|fw):/i;
  return already.test(clean) ? clean : `${prefix}: ${clean}`.trim();
}

export function signatureBlock(identity: Identity | undefined): string {
  return identity?.signatureHtml ? `<p>-- <br>${identity.signatureHtml}</p>` : "";
}

function unique(list: Address[], exclude: Set<string>): Address[] {
  const seen = new Set(exclude);
  return list.filter((a) => {
    const key = a.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function newMessageInit(identity: Identity | undefined): ComposeInit {
  return { from: identity?.address, to: [], cc: [], bcc: [], subject: "", html: `<p><br></p>${signatureBlock(identity)}` };
}

/** Pick the identity the original was addressed to, so replies come from the same address. */
function replyIdentity(message: MessageDetail, identities: Identity[]): Identity | undefined {
  // To before Cc, so the most direct address wins.
  const addressed = [...(message.direction === "out" && message.from ? [message.from] : []), ...message.to, ...message.cc];
  for (const entry of addressed) {
    const match = identities.find((i) => i.address.toLowerCase() === entry.address.toLowerCase());
    if (match) return match;
  }
  return identities.find((i) => i.isDefault) ?? identities[0];
}

export function replyInit(message: MessageDetail, content: ParsedMessage, mode: ReplyMode, identities: Identity[]): ComposeInit {
  const identity = replyIdentity(message, identities);
  const own = new Set(identities.map((i) => i.address.toLowerCase()));
  const originalText = textToHtml(content.text ?? "");
  const sender = message.from ? escapeHtml(message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address) : "(unknown sender)";

  if (mode === "forward") {
    const header = [
      "---------- Forwarded message ---------",
      `From: ${sender}`,
      `Date: ${escapeHtml(longDate(message.receivedAt))}`,
      `Subject: ${escapeHtml(message.subject ?? "")}`,
      `To: ${escapeHtml(message.to.map(displayAddress).join(", "))}`,
    ].join("<br>");
    return {
      from: identity?.address,
      to: [],
      cc: [],
      bcc: [],
      subject: prefixSubject("Fwd", message.subject),
      html: `<p><br></p>${signatureBlock(identity)}<p>${header}</p><div>${originalText}</div>`,
      forwardAttachments: message.attachments.filter((a) => !a.isInline),
    };
  }

  // Replying to our own sent mail goes to its recipients again.
  const primary = message.direction === "out" ? message.to : message.from ? [message.from] : [];
  const to = unique(mode === "replyAll" && message.direction === "in" ? [...primary, ...message.to] : primary, own);
  const cc = mode === "replyAll" ? unique(message.cc, new Set([...own, ...to.map((a) => a.address.toLowerCase())])) : [];
  return {
    from: identity?.address,
    to,
    cc,
    bcc: [],
    subject: prefixSubject("Re", message.subject),
    html: `<p><br></p>${signatureBlock(identity)}<p>On ${escapeHtml(longDate(message.receivedAt))}, ${sender} wrote:</p><blockquote>${originalText}</blockquote>`,
    replyToId: message.id,
  };
}
