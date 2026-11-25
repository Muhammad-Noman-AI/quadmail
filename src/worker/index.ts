import { parseConfig } from "../shared/env";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      parseConfig(env as unknown as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
