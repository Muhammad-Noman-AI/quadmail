import { describe, expect, it } from "vitest";
import type { OutboundMessage } from "./provider";
import { resendBodyParts, type BodyPart } from "./resend";
import { checkSend, formatMailbox, SendRuleError, utcDay } from "./rules";
import { affectedRecipients, deliveryUpdate, verifyWebhook } from "./webhook";

const base = { from: "noman@quadgentics.com", identities: ["noman@quadgentics.com"], allowedDomains: ["quadgentics.com"], cc: [], bcc: [] };

describe("checkSend", () => {
  it("accepts a valid send and dedupes recipients across To, Cc and Bcc", () => {
    const result = checkSend({ ...base, to: [{ address: "A@x.com" }], cc: [{ address: "a@x.com" }], bcc: [{ address: "b@y.com" }] });
    expect(result).toEqual({ from: "noman@quadgentics.com", recipients: ["a@x.com", "b@y.com"] });
  });

  it("refuses a From that is not one of the user's identities (no open relay)", () => {
    expect(() => checkSend({ ...base, from: "ceo@bank.com", to: [{ address: "a@x.com" }] })).toThrow(SendRuleError);
  });

  it("refuses an identity on a domain that is not allowed", () => {
    expect(() => checkSend({ ...base, from: "me@other.com", identities: ["me@other.com"], to: [{ address: "a@x.com" }] })).toThrow(/not allowed/);
  });

  it("refuses invalid addresses, empty To and too many recipients", () => {
    expect(() => checkSend({ ...base, to: [{ address: "not-an-email" }] })).toThrow(/valid/);
    expect(() => checkSend({ ...base, to: [] })).toThrow(/at least one/);
    const many = Array.from({ length: 21 }, (_, i) => ({ address: `u${i}@x.com` }));
    expect(() => checkSend({ ...base, to: many })).toThrow(/At most 20/);
  });
});

describe("formatMailbox", () => {
  it("quotes names and strips CR/LF so a name cannot inject headers", () => {
    expect(formatMailbox("a@x.com")).toBe("a@x.com");
    expect(formatMailbox("a@x.com", 'Ali "The" Khan')).toBe('"Ali \\"The\\" Khan" <a@x.com>');
    expect(formatMailbox("a@x.com", "Evil\r\nBcc: victim@y.com")).toBe('"Evil Bcc: victim@y.com" <a@x.com>');
  });
});

describe("utcDay", () => {
  it("uses the UTC date", () => {
    expect(utcDay(Date.UTC(2026, 10, 25, 23, 59))).toBe("2026-11-25");
  });
});

async function collect(parts: BodyPart[]): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (part instanceof Uint8Array) chunks.push(part);
    else for await (const chunk of part.stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream() as ReadableStream<Uint8Array>;
}

describe("resendBodyParts", () => {
  const message: OutboundMessage = {
    idempotencyKey: "k",
    from: '"Noman" <noman@quadgentics.com>',
    to: ["a@x.com"],
    cc: [],
    bcc: ["b@y.com"],
    subject: 'Quote "test"',
    html: "<p>Hi</p>",
    text: "Hi",
    headers: { "In-Reply-To": "<m1@x.com>" },
    attachments: [],
  };

  it("is plain JSON without attachments", async () => {
    const body = JSON.parse(await collect(resendBodyParts(message)));
    expect(body).toEqual({ from: message.from, to: ["a@x.com"], bcc: ["b@y.com"], subject: 'Quote "test"', html: "<p>Hi</p>", text: "Hi", headers: { "In-Reply-To": "<m1@x.com>" } });
  });

  it("splices streamed Base64 attachments into valid JSON with matching byte counts", async () => {
    const files = ["aGVsbG8=", "d29ybGQ="];
    const parts = resendBodyParts({
      ...message,
      attachments: files.map((b64, i) => ({ filename: `f${i}.txt`, contentType: i ? null : "text/plain", base64: streamOf(b64), base64Bytes: b64.length })),
    });
    const declared = parts.reduce((sum, p) => sum + (p instanceof Uint8Array ? p.byteLength : p.bytes), 0);
    const text = await collect(parts);
    expect(new TextEncoder().encode(text).byteLength).toBe(declared);
    expect(JSON.parse(text).attachments).toEqual([
      { filename: "f0.txt", content_type: "text/plain", content: "aGVsbG8=" },
      { filename: "f1.txt", content: "d29ybGQ=" },
    ]);
  });
});

describe("verifyWebhook", () => {
  // Test vector from https://docs.svix.com/receiving/verifying-payloads/how-manual
  const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl";
  const payload = '{"event_type":"ping","data":{"success":true}}';
  const headers = { id: "msg_loFOjxBNrRLzqYUf", timestamp: "1731705121", signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=" };
  const at = 1731705121 * 1000;

  it("accepts the reference signature, also among several", async () => {
    expect(await verifyWebhook(secret, headers, payload, at)).toBe(true);
    expect(await verifyWebhook(secret, { ...headers, signature: `v1,AAAA ${headers.signature}` }, payload, at)).toBe(true);
  });

  it("rejects a changed body, a wrong secret, a stale timestamp and missing headers", async () => {
    expect(await verifyWebhook(secret, headers, payload.replace("true", "false"), at)).toBe(false);
    expect(await verifyWebhook("whsec_AAAAAAAAAAAAAAAAAAAAAAAA", headers, payload, at)).toBe(false);
    expect(await verifyWebhook(secret, headers, payload, at + 6 * 60 * 1000)).toBe(false);
    expect(await verifyWebhook(secret, { ...headers, signature: null }, payload, at)).toBe(false);
  });
});

describe("deliveryUpdate", () => {
  it("suppresses the recipient of a permanent bounce", () => {
    const update = deliveryUpdate({ type: "email.bounced", data: { email_id: "e1", message_id: "<m@x>", to: ["Bad@x.com"], bounce: { type: "Permanent" } } });
    expect(update).toEqual({ providerMessageId: "e1", status: "bounced", messageIdHeader: "<m@x>", suppress: { addresses: ["bad@x.com"], reason: "bounce" } });
  });

  it("does not suppress on a transient bounce, and ignores unknown events", () => {
    expect(deliveryUpdate({ type: "email.bounced", data: { email_id: "e1", to: ["a@x.com"], bounce: { type: "Transient" } } })?.suppress).toBeNull();
    expect(deliveryUpdate({ type: "email.opened", data: { email_id: "e1" } })).toBeNull();
  });

  it("with several recipients, suppresses only the ones the bounce names", () => {
    const event = { type: "email.bounced", data: { email_id: "e1", to: ["a@x.com", "b@y.com"], bounce: { type: "Permanent", message: "550 b@y.com: no such user" } } };
    expect(affectedRecipients(event)).toEqual(["b@y.com"]);
    expect(affectedRecipients({ ...event, data: { ...event.data, bounce: { type: "Permanent", message: "rejected" } } })).toEqual([]);
  });
});
