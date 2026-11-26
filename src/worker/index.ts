import { parseConfig } from "../shared/env";
import { withApiHeaders } from "./auth/respond";
import { json } from "./http";
import { handleEmail } from "./inbound/email";
import { dispatch, type Route } from "./router";
import { authRoutes } from "./routes/auth";
import { inboundRoutes } from "./routes/inbound";
import { mailRoutes } from "./routes/mail";
import { sendRoutes } from "./routes/send";
import { teamRoutes } from "./routes/team";
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
  ...sendRoutes,
  ...teamRoutes,
];

export default {
  // Every /api response (all tracks, errors included) gets the API security headers.
  fetch: async (request, env, ctx) => withApiHeaders(await dispatch(routes, request, env, ctx)),
  email: handleEmail,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
