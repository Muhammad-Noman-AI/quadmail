// Recipient fields are plain text ("Ali <ali@x.com>, b@y.com"); these convert to and from Address lists.
import type { Address } from "../../shared/types";

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Split on commas and semicolons that are not inside quotes or angle brackets. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((t) => t.trim()).filter(Boolean);
}

export function parseAddressInput(text: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const token of tokens(text)) {
    const match = /^(.*)<([^<>]+)>$/.exec(token);
    const address = (match ? match[2]! : token).trim().toLowerCase();
    const name = match ? match[1]!.trim().replace(/^"(.*)"$/, "$1").trim() : "";
    if (!EMAIL.test(address)) invalid.push(token);
    else addresses.push(name ? { address, name } : { address });
  }
  return { addresses, invalid };
}

export function formatAddressInput(list: Address[]): string {
  return list.map((a) => (a.name ? `${/[,;"<>]/.test(a.name) ? `"${a.name.replace(/"/g, "")}"` : a.name} <${a.address}>` : a.address)).join(", ");
}
