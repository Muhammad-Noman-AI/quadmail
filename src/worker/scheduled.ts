// Daily cron: index mail whose D1 insert failed, then apply retention.
import { reconcileRaw } from "./inbound/reconcile";
import { purgeExpired } from "./storage/retention";

export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  void controller;
  const now = Date.now();
  ctx.waitUntil(
    (async () => {
      await reconcileRaw(env, now).catch((err) => console.error("reconcile failed", err instanceof Error ? err.message : "unknown"));
      const purged = await purgeExpired(env.DB, env.MAIL, now).catch((err) => {
        console.error("retention failed", err instanceof Error ? err.message : "unknown");
        return null;
      });
      if (purged?.messages) console.log("retention: purged messages", purged.messages);
    })(),
  );
}
