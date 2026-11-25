// The only seam between QuadMail and an email-sending service. No provider-specific code outside src/worker/send/.

export interface OutboundAttachment {
  filename: string;
  contentType: string | null;
  /** The file, already Base64-encoded (written at upload time), streamed from R2. */
  base64: ReadableStream<Uint8Array>;
  base64Bytes: number;
}

export interface OutboundMessage {
  /** Same key on a retry makes the provider return the first result instead of sending twice. */
  idempotencyKey: string;
  /** Formatted mailbox, e.g. `"Noman" <noman@quadgentics.com>`. */
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  attachments: OutboundAttachment[];
}

export class ProviderError extends Error {
  constructor(
    /** HTTP status from the provider, 0 when it could not be reached. */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MailProvider {
  send(message: OutboundMessage): Promise<{ providerMessageId: string }>;
}
