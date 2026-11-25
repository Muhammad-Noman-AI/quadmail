// Send rules checked before every send (master prompt section 9). Pure: no I/O, so it is unit-tested.
import { z } from "zod";
import { stripControlChars } from "../../shared/text";
import { MAX_RECIPIENTS, type Address } from "../../shared/types";

export class SendRuleError extends Error {}

const email = z.email().max(254);

export interface SendCheckInput {
  from: string;
  /** Addresses of the user's identities. */
  identities: string[];
  allowedDomains: string[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
}

export interface SendCheckResult {
  from: string;
  /** Every distinct recipient, lower-cased: the count that is charged against the daily limit. */
  recipients: string[];
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Never an open relay: From must be one of the user's own identities on an allowed sending domain.
 * Recipients must be valid addresses, at least one, at most MAX_RECIPIENTS in To + Cc + Bcc.
 */
export function checkSend(input: SendCheckInput): SendCheckResult {
  const from = input.from.trim().toLowerCase();
  if (!input.identities.some((identity) => identity.toLowerCase() === from)) {
    throw new SendRuleError("Choose a From address from your identities.");
  }
  if (!input.allowedDomains.includes(domainOf(from))) {
    throw new SendRuleError(`Sending from ${domainOf(from)} is not allowed.`);
  }

  const recipients = new Set<string>();
  for (const entry of [...input.to, ...input.cc, ...input.bcc]) {
    const address = entry.address.trim().toLowerCase();
    if (!email.safeParse(address).success) throw new SendRuleError(`"${entry.address}" is not a valid email address.`);
    recipients.add(address);
  }
  if (input.to.length === 0) throw new SendRuleError("Add at least one recipient in To.");
  if (recipients.size > MAX_RECIPIENTS) {
    throw new SendRuleError(`At most ${MAX_RECIPIENTS} recipients per message (To, Cc and Bcc together).`);
  }
  return { from, recipients: [...recipients] };
}

/**
 * RFC 5322 mailbox for the provider: `"Display Name" <addr>`. CR, LF and other control characters
 * are removed so a name can never inject a header; quotes and backslashes are escaped.
 */
export function formatMailbox(address: string, name?: string | null): string {
  const clean = stripControlChars(name ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return address;
  return `"${clean.replace(/["\\]/g, "\\$&")}" <${address}>`;
}

/** UTC day key for send_counters, matching Resend's midnight-UTC quota reset. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
