import { parseConfig } from "../shared/env";
import { json } from "./http";
import { handleEmail } from "./inbound/email";
import { dispatch, type Route } from "./router";
import { authRoutes } from "./routes/auth";
import { inboundRoutes } from "./routes/inbound";
import { mailRoutes } from "./routes/mail";
import { handleScheduled } from "./scheduled";

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/health",
    handler: ({ env }) => {
      parseConfig(env as unknown as Record<string, unknown>);
      return json({ ok: true });
    },
  },
  ...authRoutes,
  ...mailRoutes,
  ...inboundRoutes,
];

export default {
  fetch: (request, env, ctx) => dispatch(routes, request, env, ctx),
  email: handleEmail,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
