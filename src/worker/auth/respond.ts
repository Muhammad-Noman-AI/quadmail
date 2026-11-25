// Response helpers for Track B routes: security headers on every API response, errors included,
// plus the audit log. (index.ts is shared, so headers are applied here rather than globally.)
import { ulid } from "../../shared/ulid";
import { error, HttpError } from "../http";
import type { Route, RouteContext } from "../router";

const API_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

export function withApiHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(API_HEADERS)) out.headers.set(name, value);
  return out;
}

/** Wrap a handler so both success and HttpError responses carry the API security headers. */
export function secured(route: Route): Route {
  return {
    ...route,
    handler: async (context: RouteContext) => {
      try {
        return withApiHeaders(await route.handler(context));
      } catch (err) {
        if (err instanceof HttpError) return withApiHeaders(error(err.status, err.message));
        throw err;
      }
    },
  };
}

export async function readJson<T>(request: Request, parse: (value: unknown) => T): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  try {
    return parse(body);
  } catch {
    throw new HttpError(400, "Invalid request");
  }
}

/** Audit entries hold actions and ids only: never message bodies, passwords or tokens. */
export function auditStatement(db: D1Database, actor: string | null, action: string, detail?: Record<string, unknown>): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (id, at, actor, action, detail_json) VALUES (?, ?, ?, ?, ?)")
    .bind(ulid(), Date.now(), actor, action, detail ? JSON.stringify(detail) : null);
}

export async function audit(db: D1Database, actor: string | null, action: string, detail?: Record<string, unknown>): Promise<void> {
  await auditStatement(db, actor, action, detail).run();
}
