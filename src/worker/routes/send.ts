// Phase 5: identities, drafts, attachment upload, sending, suppressions and the Resend webhook.
import { z } from "zod";
import { capChars, capUtf8, stripControlChars } from "../../shared/text";
import {
  MAX_BODY_HTML_CHARS,
  MAX_OUTGOING_ATTACHMENT_BYTES,
  MAX_RECIPIENTS,
  SEARCH_TEXT_MAX_BYTES,
  SNIPPET_MAX_CHARS,
  type AttachmentMeta,
  type DraftInput,
  type Identity,
  type SendingInfo,
  type StoredBody,
} from "../../shared/types";
import { ulid } from "../../shared/ulid";
import { audit, auditStatement, readJson, secured } from "../auth/respond";
import { requireSession, type Session } from "../auth/session";
import { appConfig } from "../config";
import { HttpError, json } from "../http";
import { normalizeSubject } from "../inbound/headers";
import { referenceLookupIds } from "../inbound/threading";
import type { Route, RouteContext } from "../router";
import { ProviderError, type OutboundAttachment } from "../send/provider";
import { ResendProvider } from "../send/resend";
import { checkSend, formatMailbox, SendRuleError, utcDay } from "../send/rules";
import { deliveryUpdate, verifyWebhook, type WebhookEvent } from "../send/webhook";
import { findThreadByMessageIds, upsertAttachment } from "../storage/inbound";
import {
  attachmentsOf,
  base64Key,
  bodyKey,
  claimDraft,
  deleteAttachmentStatements,
  deleteDraftStatement,
  deliveryStatements,
  getDraft,
  insertDraft,
  insertIdentity,
  listIdentities,
  markSentStatements,
  outgoingAttachmentKey,
  releaseQuota,
  reserveQuota,
  sentOn,
  setDefaultIdentity,
  suppressedAmong,
  unclaimStatement,
  updateDraft,
  updateIdentity,
  type DraftFields,
  type DraftRow,
} from "../storage/outbound";

const id = z.string().regex(/^[0-9A-Z]{26}$/);
const address = z.object({ address: z.string().trim().max(320), name: z.string().max(200).optional() });
const addressList = z.array(address).max(100);

const draftBody = z.object({
  from: z.string().trim().max(320),
  to: addressList,
  cc: addressList,
  bcc: addressList,
  subject: z.string().max(998),
  html: z.string().max(MAX_BODY_HTML_CHARS),
  text: z.string().max(200_000),
});
const createBody = draftBody.extend({ replyToId: id.optional() });

const signature = z.string().max(10_000).nullable();
const identityPatch = z.object({ displayName: z.string().trim().max(100).nullable().optional(), signatureHtml: signature.optional(), isDefault: z.literal(true).optional() });

/** Resend caps one webhook body far below this; anything bigger is not from Resend. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

function param(value: string | undefined): string {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid id");
  return parsed.data;
}

function parseAddresses(value: string | null): Array<{ address: string; name?: string }> {
  try {
    const list = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(list) ? (list as Array<{ address: string; name?: string }>) : [];
  } catch {
    return [];
  }
}

function parseStringList(value: string | null): string[] {
  try {
    const list = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function cleanAddresses(list: DraftInput["to"]): DraftInput["to"] {
  return list
    .filter((a) => a.address)
    .map((a) => {
      const name = a.name ? stripControlChars(a.name).trim() : "";
      return name ? { address: a.address.toLowerCase(), name } : { address: a.address.toLowerCase() };
    });
}

function draftFields(input: DraftInput, identities: Identity[]): DraftFields {
  const identity = identities.find((i) => i.address.toLowerCase() === input.from.toLowerCase());
  const flat = input.text.replace(/\s+/g, " ").trim();
  return {
    from: input.from,
    fromName: identity?.displayName ?? null,
    to: cleanAddresses(input.to),
    cc: cleanAddresses(input.cc),
    bcc: cleanAddresses(input.bcc),
    subject: input.subject,
    snippet: capChars(flat, SNIPPET_MAX_CHARS),
    searchText: capUtf8(flat, SEARCH_TEXT_MAX_BYTES),
  };
}

async function putBody(env: Env, messageId: string, body: StoredBody): Promise<void> {
  await env.MAIL.put(bodyKey(messageId), JSON.stringify({ html: body.html, text: body.text }), { httpMetadata: { contentType: "application/json" } });
}

async function requireDraft(env: Env, session: Session, messageId: string): Promise<DraftRow> {
  const draft = await getDraft(env.DB, session.userId, messageId);
  if (!draft) throw new HttpError(404, "Draft not found. It may have been sent or deleted.");
  return draft;
}

async function identitiesWithDefault(env: Env, session: Session): Promise<Identity[]> {
  const identities = await listIdentities(env.DB, session.userId);
  if (identities.length) return identities;
  // First use: the login address is the default identity.
  await insertIdentity(env.DB, { id: ulid(), userId: session.userId, address: session.email, displayName: null, signatureHtml: null, isDefault: true }).run();
  return listIdentities(env.DB, session.userId);
}

/** Load the stored body and the Base64 attachment streams of a draft, before it is claimed. */
async function loadOutgoing(env: Env, draft: DraftRow): Promise<{ body: StoredBody; attachments: OutboundAttachment[]; base64Keys: string[] }> {
  const object = draft.html_key ? await env.MAIL.get(draft.html_key) : null;
  if (!object) throw new HttpError(500, "The draft body is missing from storage.");
  const body = (await object.json()) as StoredBody;
  const rows = await attachmentsOf(env.DB, draft.id);
  const attachments: OutboundAttachment[] = [];
  for (const row of rows) {
    const encoded = await env.MAIL.get(base64Key(row.r2_key));
    if (!encoded) throw new HttpError(500, `Attachment "${row.filename ?? row.id}" is missing from storage. Remove it and attach it again.`);
    attachments.push({ filename: row.filename ?? "attachment", contentType: row.content_type, base64: encoded.body, base64Bytes: encoded.size });
  }
  return { body, attachments, base64Keys: rows.map((row) => base64Key(row.r2_key)) };
}

async function send({ request, env, ctx, params }: RouteContext): Promise<Response> {
  const session = await requireSession(request, env);
  const cfg = await appConfig(env);
  const draft = await requireDraft(env, session, param(params.id));
  const identities = await identitiesWithDefault(env, session);
  const to = parseAddresses(draft.to_json);
  const cc = parseAddresses(draft.cc_json);
  const bcc = parseAddresses(draft.bcc_json);
  let rules;
  try {
    rules = checkSend({ from: draft.from_addr ?? "", identities: identities.map((i) => i.address), allowedDomains: cfg.allowedDomains, to, cc, bcc });
  } catch (err) {
    if (err instanceof SendRuleError) throw new HttpError(400, err.message);
    throw err;
  }
  const blocked = await suppressedAmong(env.DB, rules.recipients);
  if (blocked.length) {
    throw new HttpError(400, `Not sent: ${blocked.join(", ")} bounced or complained before. Remove them, or clear them in Settings → Suppressed addresses.`);
  }

  if (cfg.provider !== "resend") throw new HttpError(501, "Cloudflare Email Sending needs the Workers Paid plan. Set MAIL_PROVIDER to resend.");
  if (!cfg.resendApiKey) throw new HttpError(503, "Sending is not set up yet: connect Resend first.");
  const provider = new ResendProvider(cfg.resendApiKey, undefined, cfg.resendApiBase);

  const references = parseStringList(draft.references_json);
  const subject = draft.subject ?? "";
  const existingThread = await findThreadByMessageIds(env.DB, session.userId, referenceLookupIds(draft.in_reply_to, references));
  const thread = { id: existingThread ?? ulid(), isNew: !existingThread, subjectNorm: normalizeSubject(subject) };
  const outgoing = await loadOutgoing(env, draft);

  const now = Date.now();
  const day = utcDay(now);
  if (!(await claimDraft(env.DB, draft.id, draft.received_at, now))) {
    throw new HttpError(409, "The draft changed or is already being sent. Try again.");
  }
  if (!(await reserveQuota(env.DB, day, rules.recipients.length, cfg.dailyLimit))) {
    // Keep received_at: a retry of the same draft then reuses the same idempotency key.
    await env.DB.batch([unclaimStatement(env.DB, draft.id, draft.received_at), auditStatement(env.DB, session.email, "send.limit", { id: draft.id })]);
    const used = await sentOn(env.DB, day);
    throw new HttpError(429, `Daily send limit reached (${used} of ${cfg.dailyLimit} used, each recipient counts). Sending resumes at midnight UTC.`);
  }

  const identity = identities.find((i) => i.address.toLowerCase() === rules.from)!;
  const headers: Record<string, string> = {};
  if (draft.in_reply_to) headers["In-Reply-To"] = draft.in_reply_to;
  if (references.length) headers.References = references.join(" ");
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await provider.send({
      // Same key while the draft is unchanged, so a retry after a timeout cannot send twice (Resend keeps keys 24 h).
      idempotencyKey: `${draft.id}-${draft.received_at}`,
      from: formatMailbox(rules.from, identity.displayName),
      to: to.map((a) => formatMailbox(a.address, a.name)),
      cc: cc.map((a) => formatMailbox(a.address, a.name)),
      bcc: bcc.map((a) => formatMailbox(a.address, a.name)),
      subject,
      html: outgoing.body.html,
      text: outgoing.body.text,
      headers,
      attachments: outgoing.attachments,
    }));
  } catch (err) {
    await env.DB.batch([
      unclaimStatement(env.DB, draft.id, draft.received_at),
      releaseQuota(env.DB, day, rules.recipients.length),
      auditStatement(env.DB, session.email, "send.failed", { id: draft.id, status: err instanceof ProviderError ? err.status : -1 }),
    ]);
    if (err instanceof ProviderError) throw new HttpError(err.status === 429 ? 429 : 502, err.message);
    throw err;
  }

  await env.DB.batch([
    ...markSentStatements(env.DB, draft.id, providerMessageId, thread, now),
    auditStatement(env.DB, session.email, "send.ok", { id: draft.id, recipients: rules.recipients.length }),
  ]);
  // The Base64 copies were only needed for this request; the binary files stay for download and forwarding.
  if (outgoing.base64Keys.length) ctx.waitUntil(env.MAIL.delete(outgoing.base64Keys));
  return json({ ok: true, id: draft.id, threadId: thread.id });
}

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/sending",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      const cfg = await appConfig(env);
      const info: SendingInfo = {
        identities: await identitiesWithDefault(env, session),
        sentToday: await sentOn(env.DB, utcDay(Date.now())),
        dailyLimit: cfg.dailyLimit,
        maxRecipients: MAX_RECIPIENTS,
        maxAttachmentBytes: MAX_OUTGOING_ATTACHMENT_BYTES,
        allowedDomains: cfg.allowedDomains,
        providerReady: cfg.provider === "resend" && !!cfg.resendApiKey,
      };
      return json(info);
    },
  },
  {
    method: "PATCH",
    path: "/api/identities/:id",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const identityId = param(params.id);
      const body = await readJson(request, (v) => identityPatch.parse(v));
      const statements = [updateIdentity(env.DB, session.userId, identityId, { displayName: body.displayName === undefined ? undefined : body.displayName || null, signatureHtml: body.signatureHtml })];
      if (body.isDefault) statements.push(setDefaultIdentity(env.DB, session.userId, identityId));
      await env.DB.batch(statements);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/drafts",
    handler: async ({ request, env }) => {
      const session = await requireSession(request, env);
      const body = await readJson(request, (v) => createBody.parse(v));
      let reply = { inReplyTo: null as string | null, references: [] as string[] };
      if (body.replyToId) {
        const original = await env.DB.prepare("SELECT message_id_hdr, references_json FROM messages WHERE id = ? AND user_id = ?")
          .bind(body.replyToId, session.userId)
          .first<{ message_id_hdr: string | null; references_json: string | null }>();
        if (!original) throw new HttpError(404, "The message you are replying to no longer exists.");
        const refs = [...parseStringList(original.references_json), ...(original.message_id_hdr ? [original.message_id_hdr] : [])];
        reply = { inReplyTo: original.message_id_hdr, references: [...new Set(refs)].slice(-20) };
      }
      const draftId = ulid();
      const now = Date.now();
      await putBody(env, draftId, body);
      await insertDraft(env.DB, session.userId, draftId, draftFields(body, await listIdentities(env.DB, session.userId)), reply, now).run();
      return json({ id: draftId, savedAt: now }, { status: 201 });
    },
  },
  {
    method: "PUT",
    path: "/api/drafts/:id",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const draftId = param(params.id);
      const body = await readJson(request, (v) => draftBody.parse(v));
      const now = Date.now();
      // D1 first: once a draft is sent the update matches nothing, so the sent body in R2 is never overwritten.
      if (!(await updateDraft(env.DB, session.userId, draftId, draftFields(body, await listIdentities(env.DB, session.userId)), now))) {
        throw new HttpError(409, "This draft was already sent or deleted.");
      }
      await putBody(env, draftId, body);
      return json({ savedAt: now });
    },
  },
  {
    method: "DELETE",
    path: "/api/drafts/:id",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const draft = await requireDraft(env, session, param(params.id));
      const rows = await attachmentsOf(env.DB, draft.id);
      await env.DB.batch([deleteDraftStatement(env.DB, session.userId, draft.id), auditStatement(env.DB, session.email, "draft.deleted", { id: draft.id })]);
      await env.MAIL.delete([bodyKey(draft.id), ...rows.flatMap((row) => [row.r2_key, base64Key(row.r2_key)])]);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/drafts/:id/attachments",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const draft = await requireDraft(env, session, param(params.id));
      const length = Number(request.headers.get("content-length"));
      if (!Number.isFinite(length) || length <= 0) throw new HttpError(411, "Content-Length required");
      const used = (await attachmentsOf(env.DB, draft.id)).reduce((sum, row) => sum + row.size_bytes, 0);
      if (used + length > MAX_OUTGOING_ATTACHMENT_BYTES) throw new HttpError(413, "Attachments are limited to 10 MB per message.");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength !== length) throw new HttpError(400, "Upload was incomplete");

      let filename = "attachment";
      try {
        filename = stripControlChars(decodeURIComponent(request.headers.get("x-filename") ?? "")).replace(/[/\\]/g, "_").trim().slice(0, 255) || filename;
      } catch {
        // keep the default name
      }
      const meta: AttachmentMeta = {
        id: ulid(),
        filename,
        contentType: (request.headers.get("content-type") ?? "").slice(0, 255) || "application/octet-stream",
        sizeBytes: length,
        contentId: null,
        isInline: false,
      };
      const key = outgoingAttachmentKey(draft.id, meta.id);
      // Encode once here (native, per file) so the send request only streams bytes.
      await Promise.all([env.MAIL.put(key, bytes), env.MAIL.put(base64Key(key), bytes.toBase64())]);
      await upsertAttachment(env.DB, draft.id, meta, key);
      return json(meta, { status: 201 });
    },
  },
  {
    method: "DELETE",
    path: "/api/drafts/:id/attachments/:attachmentId",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const draft = await requireDraft(env, session, param(params.id));
      const attachmentId = param(params.attachmentId);
      const row = (await attachmentsOf(env.DB, draft.id)).find((a) => a.id === attachmentId);
      if (!row) throw new HttpError(404, "Attachment not found");
      await env.DB.batch(deleteAttachmentStatements(env.DB, draft.id, attachmentId));
      await env.MAIL.delete([row.r2_key, base64Key(row.r2_key)]);
      return json({ ok: true });
    },
  },
  { method: "POST", path: "/api/drafts/:id/send", handler: send },
  {
    method: "GET",
    path: "/api/messages/:id/body",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const row = await env.DB.prepare("SELECT html_key FROM messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
        .bind(param(params.id), session.userId)
        .first<{ html_key: string | null }>();
      const object = row?.html_key ? await env.MAIL.get(row.html_key) : null;
      if (!object) throw new HttpError(404, "Message body not found");
      return new Response(object.body, { headers: { "content-type": "application/json", "content-length": String(object.size) } });
    },
  },
  {
    method: "GET",
    path: "/api/suppressions",
    handler: async ({ request, env }) => {
      await requireSession(request, env);
      const { results } = await env.DB.prepare("SELECT address, reason, created_at AS createdAt FROM suppressions ORDER BY created_at DESC").all();
      return json({ items: results });
    },
  },
  {
    method: "DELETE",
    path: "/api/suppressions/:address",
    handler: async ({ request, env, params }) => {
      const session = await requireSession(request, env);
      const addr = (params.address ?? "").toLowerCase();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM suppressions WHERE address = ?").bind(addr),
        auditStatement(env.DB, session.email, "suppression.removed", { address: addr }),
      ]);
      return json({ ok: true });
    },
  },
  {
    // Called by Resend, not the browser: no session or Origin; the Svix signature is the authentication.
    method: "POST",
    path: "/api/webhooks/resend",
    handler: async ({ request, env }) => {
      const secret = (await appConfig(env)).webhookSecret;
      if (!secret) throw new HttpError(503, "Webhook secret is not configured");
      if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) throw new HttpError(413, "Payload too large");
      const raw = await request.text();
      if (raw.length > MAX_WEBHOOK_BYTES) throw new HttpError(413, "Payload too large");
      const valid = await verifyWebhook(
        secret,
        { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") },
        raw,
        Date.now(),
      );
      if (!valid) throw new HttpError(401, "Invalid signature");
      let event: WebhookEvent;
      try {
        event = JSON.parse(raw) as WebhookEvent;
      } catch {
        throw new HttpError(400, "Invalid JSON");
      }
      const update = event && typeof event === "object" && event.data ? deliveryUpdate(event) : null;
      if (update) {
        await env.DB.batch(deliveryStatements(env.DB, update, Date.now()));
        if (update.suppress?.addresses.length) await audit(env.DB, "resend", "suppression.added", { reason: update.suppress.reason, count: update.suppress.addresses.length });
      }
      return json({ ok: true });
    },
  },
];

export const sendRoutes: Route[] = routes.map(secured);
