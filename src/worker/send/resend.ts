// Resend REST API: https://resend.com/docs/api-reference/emails/send-email
// The request body is streamed: JSON text from the Worker, attachment Base64 straight from R2.
// No byte of an attachment is touched here, so a 10 MB send stays inside the 10 ms CPU limit.
import type { MailProvider, OutboundMessage } from "./provider";
import { ProviderError } from "./provider";

const encoder = new TextEncoder();

export type BodyPart = Uint8Array | { stream: ReadableStream<Uint8Array>; bytes: number };

/**
 * The JSON request body as ordered parts. Base64 never needs JSON escaping, so each attachment's
 * stream is placed between `"content":"` and `"` as-is. Exported for tests.
 */
export function resendBodyParts(message: OutboundMessage): BodyPart[] {
  const head: Record<string, unknown> = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (message.cc.length) head.cc = message.cc;
  if (message.bcc.length) head.bcc = message.bcc;
  if (Object.keys(message.headers).length) head.headers = message.headers;
  if (!message.attachments.length) return [encoder.encode(JSON.stringify(head))];

  const json = JSON.stringify(head);
  const parts: BodyPart[] = [encoder.encode(`${json.slice(0, -1)},"attachments":[`)];
  message.attachments.forEach((attachment, index) => {
    const meta = JSON.stringify({ filename: attachment.filename, ...(attachment.contentType ? { content_type: attachment.contentType } : {}) });
    parts.push(encoder.encode(`${index ? "," : ""}${meta.slice(0, -1)},"content":"`));
    parts.push({ stream: attachment.base64, bytes: attachment.base64Bytes });
    parts.push(encoder.encode(`"}`));
  });
  parts.push(encoder.encode("]}"));
  return parts;
}

async function pump(parts: BodyPart[], writable: WritableStream<Uint8Array>): Promise<void> {
  const writer = writable.getWriter();
  try {
    for (const part of parts) {
      if (part instanceof Uint8Array) {
        await writer.write(part);
        continue;
      }
      const reader = part.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    }
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => {});
  }
}

function friendlyError(status: number, name: string, message: string): string {
  if (name === "daily_quota_exceeded") return "Resend's daily quota (100 emails) is used up. It resets at midnight UTC.";
  if (name === "monthly_quota_exceeded") return "Resend's monthly quota (3,000 emails) is used up.";
  if (status === 429) return "Resend is rate-limiting requests. Try again in a minute.";
  if (status === 401 || status === 403) return `Resend refused the request: ${message || "check the API key and the verified domain"}`;
  return `Resend could not send the message${message ? `: ${message}` : ` (HTTP ${status})`}`;
}

export class ResendProvider implements MailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    /** https://api.resend.com, or a local mock in tests. */
    private readonly base = "https://api.resend.com",
  ) {}

  async send(message: OutboundMessage): Promise<{ providerMessageId: string }> {
    const parts = resendBodyParts(message);
    let body: BodyInit;
    if (parts.length === 1 && parts[0] instanceof Uint8Array) {
      body = parts[0];
    } else {
      const total = parts.reduce((sum, part) => sum + (part instanceof Uint8Array ? part.byteLength : part.bytes), 0);
      const { readable, writable } = new FixedLengthStream(total);
      // Not awaited: if Resend answers early (e.g. 401) the pump stops when the stream is dropped.
      void pump(parts, writable);
      body = readable;
    }

    let response: Response;
    try {
      response = await this.fetcher(`${this.base}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey,
          "user-agent": "QuadMail",
        },
        body,
      });
    } catch {
      throw new ProviderError(0, "Could not reach Resend. Check your connection and try again.");
    }

    const data = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown; message?: unknown };
    if (response.ok && typeof data.id === "string") return { providerMessageId: data.id };
    const name = typeof data.name === "string" ? data.name : "";
    const text = typeof data.message === "string" ? data.message.slice(0, 300) : "";
    throw new ProviderError(response.status, friendlyError(response.status, name, text));
  }
}
