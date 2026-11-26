// Email Routing handler. Must stay far under the 10 ms Workers Free CPU limit: headers only, no MIME parsing.
// Order matters: the raw message is in R2 before anything else touches it, so no accepted mail is lost.
import { ulid } from "../../shared/ulid";
import { findSubjectCandidates, findThreadByMessageIds, insertInbound, isBlockedSender, rawKey, resolveRecipientOwner } from "../storage/inbound";
import { extractInboundHeaders, normalizeSubject } from "./headers";
import { pickSubjectThread, referenceLookupIds, SUBJECT_THREAD_WINDOW_MS } from "./threading";

/** Own cap, below Email Routing's 25 MiB limit. */
export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;

export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  void ctx;
  if (message.rawSize > MAX_INBOUND_BYTES) {
    message.setReject(`Message too large: ${message.rawSize} bytes, limit is ${MAX_INBOUND_BYTES} bytes`);
    return;
  }

  const receivedAt = Date.now();
  const id = ulid(receivedAt);
  const key = rawKey(id, receivedAt);

  try {
    // R2 needs a known length for streamed bodies; FixedLengthStream supplies it without buffering.
    await env.MAIL.put(key, message.raw.pipeThrough(new FixedLengthStream(message.rawSize)), {
      httpMetadata: { contentType: "message/rfc822" },
      // Envelope data lets the reconcile job rebuild a row if the D1 insert below fails.
      customMetadata: { envelopeFrom: message.from.slice(0, 320), envelopeTo: message.to.slice(0, 320) },
    });
  } catch (err) {
    console.error("inbound: R2 write failed", id, err instanceof Error ? err.message : "unknown");
    // setReject is the only documented failure path (permanent SMTP error), so the sender gets a bounce
    // instead of silent loss. Whether a thrown error yields a retryable 4xx is not documented:
    // https://developers.cloudflare.com/email-service/api/route-emails/email-handler/
    message.setReject("Temporary storage failure, please try again later");
    return;
  }

  // From here on the mail is safe in R2. Any failure is logged, never rejected: the daily reconcile indexes it.
  try {
    const headers = extractInboundHeaders(message.headers);
    const envelopeFrom = message.from.toLowerCase();
    const senders = [envelopeFrom, headers.from?.address ?? ""];
    const subjectNorm = normalizeSubject(headers.subject);
    // Email Routing calls the handler once per envelope recipient: that address decides the mailbox.
    const userId = await resolveRecipientOwner(env.DB, message.to);
    if (!userId) throw new Error("no active admin to receive mail");

    const [blocked, referencedThread] = await Promise.all([
      isBlockedSender(env.DB, userId, senders),
      findThreadByMessageIds(env.DB, userId, referenceLookupIds(headers.inReplyTo, headers.references)),
    ]);
    let threadId = referencedThread;
    if (!threadId) {
      const candidates = await findSubjectCandidates(env.DB, userId, subjectNorm, receivedAt - SUBJECT_THREAD_WINDOW_MS);
      threadId = pickSubjectThread(subjectNorm, senders.filter(Boolean), candidates, receivedAt);
    }
    const isNew = threadId == null;

    await insertInbound(
      env.DB,
      {
        id,
        userId,
        threadId: threadId ?? ulid(receivedAt),
        folder: blocked ? "spam" : "inbox",
        messageIdHdr: headers.messageId,
        inReplyTo: headers.inReplyTo,
        references: headers.references,
        envelopeFrom,
        envelopeTo: message.to.toLowerCase(),
        from: headers.from,
        to: headers.to,
        cc: headers.cc,
        subject: headers.subject,
        rawKey: key,
        sizeBytes: message.rawSize,
        authResults: headers.authResults,
        receivedAt,
      },
      { isNew, subjectNorm },
    );
  } catch (err) {
    console.error("inbound: indexing failed, reconcile will retry", id, err instanceof Error ? err.message : "unknown");
  }
}
