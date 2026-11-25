// Resend webhooks are signed with Svix: https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
// Signed content is `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256 with the Base64 key after `whsec_`.
import type { SendStatus } from "../../shared/types";

/** Reject deliveries whose timestamp is further than this from our clock (replay protection). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowMs: number,
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  if (!keyBytes?.length) return false;
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${rawBody}`)));
  // The header is a space-separated list of `v1,<base64>`; any one match is valid (key rotation).
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    const candidate = version === "v1" && value ? base64ToBytes(value) : null;
    return candidate !== null && equalBytes(candidate, expected);
  });
}

export interface WebhookEvent {
  type: string;
  data: {
    email_id?: string;
    message_id?: string;
    to?: string[];
    bounce?: { type?: string; message?: string; diagnosticCode?: string[] };
  };
}

export interface DeliveryUpdate {
  providerMessageId: string;
  status: SendStatus | null;
  /** RFC Message-ID Resend actually used, so replies to this mail thread correctly. */
  messageIdHeader: string | null;
  suppress: { addresses: string[]; reason: "bounce" | "complaint" | "provider" } | null;
}

/**
 * Which recipients a bounce or complaint is about. An event covers the whole email, so with several
 * recipients only addresses named in the bounce text are suppressed; never suppress a guess.
 */
export function affectedRecipients(event: WebhookEvent): string[] {
  const to = (event.data.to ?? []).map((a) => a.toLowerCase());
  if (to.length <= 1) return to;
  const text = [event.data.bounce?.message ?? "", ...(event.data.bounce?.diagnosticCode ?? [])].join(" ").toLowerCase();
  return to.filter((address) => text.includes(address));
}

/** Map a webhook event to a status change, or null for events we ignore (opened, clicked, delayed...). */
export function deliveryUpdate(event: WebhookEvent): DeliveryUpdate | null {
  const providerMessageId = event.data.email_id;
  if (!providerMessageId) return null;
  const base = { providerMessageId, messageIdHeader: event.data.message_id ?? null, suppress: null };
  switch (event.type) {
    case "email.sent":
      return { ...base, status: "sent" };
    case "email.delivered":
      return { ...base, status: "delivered" };
    case "email.failed":
      return { ...base, status: "failed" };
    case "email.bounced": {
      // Transient (soft) bounces are retried by the receiving side; only Permanent ones suppress.
      if (event.data.bounce?.type !== "Permanent") return { ...base, status: null };
      return { ...base, status: "bounced", suppress: { addresses: affectedRecipients(event), reason: "bounce" } };
    }
    case "email.complained":
      return { ...base, status: "complained", suppress: { addresses: affectedRecipients(event), reason: "complaint" } };
    case "email.suppressed":
      return { ...base, status: "failed", suppress: { addresses: affectedRecipients(event), reason: "provider" } };
    default:
      return null;
  }
}
