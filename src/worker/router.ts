import { error, HttpError } from "./http";

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  params: Record<string, string>;
  url: URL;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path pattern like `/api/messages/:id`. */
  path: string;
  handler: (context: RouteContext) => Promise<Response> | Response;
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = pathname.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const part = a[i]!;
    const value = b[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(value);
    else if (part !== value) return null;
  }
  return params;
}

export async function dispatch(routes: Route[], request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  let pathMatched = false;
  for (const route of routes) {
    const params = matchPath(route.path, url.pathname);
    if (!params) continue;
    pathMatched = true;
    if (route.method !== request.method) continue;
    try {
      return await route.handler({ request, env, ctx, params, url });
    } catch (err) {
      if (err instanceof HttpError) return error(err.status, err.message);
      // Never log request bodies: they can contain mail content.
      console.error("route failed", route.method, route.path, err instanceof Error ? err.message : err);
      return error(500, "Internal error");
    }
  }
  return pathMatched ? error(405, "Method not allowed") : error(404, "Not found");
}
