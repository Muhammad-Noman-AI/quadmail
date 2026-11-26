// Track A (Phase 3): raw message fetch, parsed-result write-back, attachments, reprocess.
import { z } from "zod";
import { SEARCH_TEXT_MAX_BYTES, SNIPPET_MAX_CHARS } from "../../shared/types";
import { requireSession, type Session } from "../auth/session";
import { HttpError, json } from "../http";
import { normalizeSubject, parseMessageIds } from "../inbound/headers";
import { capChars, capUtf8 } from "../../shared/text";
import type { Route, RouteContext } from "../router";
import {
  attachmentKey,
  getAttachment,
  getMessageRef,
  markParseFailed,
  markPending,
  pendingIds,
  saveParsed,
  threadUnthreaded,
  upsertAttachment,
  type MessageRef,
} from "../storage/inbound";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const address = z.object({ address: z.string().max(320), name: z.string().max(500).optional() });
const addresses = z.array(address).max(200);

export const parsedBodySchema = z.object({
  from: address.nullable(),
  to: addresses,
  cc: addresses,
  subject: z.string().max(4000).nullable(),
  snippet: z.string().max(10_000),
  searchText: z.string().max(200_000),
  messageId: z.string().max(2000).nullable().optional(),
  inReplyTo: z.string().max(2000).nullable().optional(),
  references: z.string().max(20_000).nullable().optional(),
  attachments: z
    .array(
      z.object({
        id: z.string().regex(ID_PATTERN),
        filename: z.string().max(1000).nullable(),
        contentType: z.string().max(255).nullable(),
        sizeBytes: z.number().int().nonnegative(),
        contentId: z.string().max(1000).nullable(),
        isInline: z.boolean(),
      }),
    )
    .max(500),
});

const parseFailedSchema = z.object({ error: z.string().max(10_000) });

function validId(id: string | undefined): string {
  if (!id || !ID_PATTERN.test(id)) throw new HttpError(400, "Invalid id");
  return id;
}

async function loadMessage({ env, params }: RouteContext, session: Session): Promise<MessageRef> {
  const ref = await getMessageRef(env.DB, session.userId, validId(params.id));
  if (!ref) throw new HttpError(404, "Message not found");
  return ref;
}

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, "Invalid request body");
  return result.data;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(filename: string | null): string {
  const name = (filename ?? "attachment").replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "attachment";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export const inboundRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/inbound/pending",
    handler: async (context) => {
      const session = await requireSession(context.request, context.env);
      const limit = Math.min(Math.max(Number(context.url.searchParams.get("limit")) || 10, 1), 50);
      return json({ ids: await pendingIds(context.env.DB, session.userId, limit) });
    },
  },
  {
    method: "GET",
    path: "/api/messages/:id/raw",
    handler: async (context) => {
      const session = await requireSession(context.request, context.env);
      const ref = await loadMessage(context, session);
      if (!ref.rawKey) throw new HttpError(404, "No raw message");
      const object = await context.env.MAIL.get(ref.rawKey);
      if (!object) throw new HttpError(404, "Raw message missing from storage");
      return new Response(object.body, {
        headers: { ...privateHeaders, "content-type": "message/rfc822", "content-length": String(object.size) },
      });
    },
  },
  {
    method: "POST",
    path: "/api/messages/:id/parsed",
    handler: async (context) => {
      const session = await requireSession(context.request, context.env);
      const ref = await loadMessage(context, session);
      const body = await readJson(context.request, parsedBodySchema);
      await saveParsed(
        context.env.DB,
        ref,
        {
          from: body.from ? { ...body.from, address: body.from.address.toLowerCase() } : null,
          to: body.to,
          cc: body.cc,
          subject: body.subject,
          snippet: capChars(body.snippet, SNIPPET_MAX_CHARS),
          searchText: capUtf8(body.searchText, SEARCH_TEXT_MAX_BYTES),
          hasAttachments: body.attachments.some((a) => !a.isInline),
        },
        normalizeSubject(body.subject),
      );
      if (!ref.threadId) {
        // Mail rebuilt by the reconcile job had no headers; thread it now that the browser has them.
        await threadUnthreaded(context.env.DB, session.userId, ref.id, {
          messageId: parseMessageIds(body.messageId)[0] ?? null,
          inReplyTo: parseMessageIds(body.inReplyTo)[0] ?? null,
          references: parseMessageIds(body.references),
          subjectNorm: normalizeSubject(body.subject),
        });
      }
      return json({ ok: true });
    },
  },
  {
    method: "PUT",
    path: "/api/messages/:id/attachments/:attachmentId",
    handler: async (context) => {
      const session = await requireSession(context.request, context.env);
      const ref = await loadMessage(context, session);
      const attachmentId = validId(context.params.attachmentId);
      const { request } = context;
      const length = Number(request.headers.get("content-length"));
      if (!Number.isFinite(length) || length <= 0 || !request.body) throw new HttpError(411, "Content-Length required");
      if (length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "Attachment too large");
      const key = attachmentKey(ref.id, attachmentId);
      await context.env.MAIL.put(key, request.body, { httpMetadata: { contentType: "application/octet-stream" } });
      const filename = request.headers.get("x-filename");
      await upsertAttachment(
        context.env.DB,
        ref.id,
        {
          id: attachmentId,
          filename: filename ? decodeURIComponent(filename).slice(0, 1000) : null,
          contentType: request.headers.get("content-type")?.slice(0, 255) ?? null,
          sizeBytes: length,
          contentId: request.headers.get("x-content-id")?.slice(0, 1000) || null,
          isInline: request.headers.get("x-inline") === "1",
        },
        key,
      );
      return json({ ok: true });
    },
  },
  {
    method: "GET",
    path: "/api/attachments/:id",
    handler: async (context) => {
      const session = await requireSession(context.request, context.env);
      const attachment = await getAttachment(context.env.DB, session.userId, validId(context.params.id));
      if (!attachment) throw new HttpError(404, "Attachment not found");
      const object = await context.env.MAIL.get(attachment.r2Key);
      if (!object) throw new HttpError(404, "Attachment missing from storage");
      return new Response(object.body, {
        headers: {
          ...privateHeaders,
          // Always a download, never rendered inline: attachment content is untrusted.
          "content-type": "application/octet-stream",
          "content-disposition": contentDisposition(attachment.filename),
          "content-length": String(object.size),
        },
      });
    },
  },
  {
    method: "POST",
    path: "/api/messages/:id/parse-failed",
    handler: async (context) => {
      const session = await requireSession(context.request, context.env);
      const ref = await loadMessage(context, session);
      const body = await readJson(context.request, parseFailedSchema);
      await markParseFailed(context.env.DB, ref.id, capChars(body.error, 500));
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/messages/:id/reprocess",
    handler: async (context) => {
      const session = await requireSession(context.request, context.env);
      const id = validId(context.params.id);
      if (!(await markPending(context.env.DB, session.userId, id))) throw new HttpError(404, "Message not found");
      return json({ ok: true });
    },
  },
];
