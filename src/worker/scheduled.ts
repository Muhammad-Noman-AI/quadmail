// Daily cron. Phase 6 adds retention here.
import { reconcileRaw } from "./inbound/reconcile";

export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  void controller;
  ctx.waitUntil(
    reconcileRaw(env).catch((err) => console.error("reconcile failed", err instanceof Error ? err.message : "unknown")),
  );
}
