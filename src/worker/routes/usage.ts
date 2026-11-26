// Usage against the free-tier limits (docs/PLAN.md), for the admin. Numbers come from D1 only:
// listing R2 would cost Class A operations, so storage is estimated from the sizes D1 records.
import type { Usage } from "../../shared/types";
import { secured } from "../auth/respond";
import { config, requireAdmin } from "../auth/session";
import { json } from "../http";
import type { Route } from "../router";
import { utcDay } from "../send/rules";
import { RETENTION_DAYS } from "../storage/retention";

const MB = 1024 * 1024;

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/usage",
    handler: async ({ request, env }) => {
      await requireAdmin(request, env);
      const today = utcDay(Date.now());
      const [perUser, storage, sends] = await env.DB.batch<Record<string, number | string | null>>([
        env.DB.prepare(
          `SELECT u.email, COUNT(m.id) AS messages FROM users u LEFT JOIN messages m ON m.user_id = u.id AND m.deleted_at IS NULL
           GROUP BY u.id ORDER BY u.created_at`,
        ),
        env.DB.prepare(
          `SELECT (SELECT COALESCE(SUM(size_bytes), 0) FROM messages) AS raw_bytes,
                  (SELECT COALESCE(SUM(size_bytes), 0) FROM attachments) AS attachment_bytes,
                  (SELECT COUNT(*) FROM messages) AS messages`,
        ),
        env.DB.prepare(
          `SELECT (SELECT COALESCE(SUM(count), 0) FROM send_counters WHERE day = ?) AS today,
                  (SELECT COALESCE(SUM(count), 0) FROM send_counters WHERE day LIKE ?) AS month`,
        ).bind(today, `${today.slice(0, 7)}-%`),
      ]);
      const s = storage!.results[0] as { raw_bytes: number; attachment_bytes: number; messages: number };
      const t = sends!.results[0] as { today: number; month: number };
      const usage: Usage = {
        // D1 reports the database size with every query result.
        d1Bytes: storage!.meta.size_after,
        d1LimitBytes: 500 * MB,
        r2Bytes: s.raw_bytes + s.attachment_bytes,
        r2LimitBytes: 10 * 1024 * MB,
        messages: s.messages,
        perUser: (perUser!.results as Array<{ email: string; messages: number }>).map((r) => ({ email: r.email, messages: r.messages })),
        sentToday: t.today,
        dailyLimit: config(env).DAILY_SEND_LIMIT,
        providerDailyLimit: 100,
        sentThisMonth: t.month,
        providerMonthlyLimit: 3000,
        retentionDays: RETENTION_DAYS,
      };
      return json(usage);
    },
  },
];

export const usageRoutes: Route[] = routes.map(secured);
