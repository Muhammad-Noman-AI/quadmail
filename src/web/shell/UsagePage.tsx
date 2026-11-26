// Admin page: how much of each free-tier limit is used, with a warning from 80%.
import { useEffect, useState } from "react";
import type { Usage } from "../../shared/types";
import { api, ApiError } from "../api";
import { formatBytes } from "../format";

const WARN_AT = 0.8;

function Meter({ label, used, limit, format = String, note }: { label: string; used: number; limit: number; format?: (n: number) => string; note?: string }) {
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0;
  const warn = ratio >= WARN_AT;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className={warn ? "font-medium text-amber-700 dark:text-amber-300" : "text-neutral-600 dark:text-neutral-400"}>
          {format(used)} of {format(limit)} ({Math.round(ratio * 100)}%)
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <div className={`h-full rounded-full ${warn ? "bg-amber-500" : "bg-blue-600"}`} style={{ width: `${Math.max(ratio * 100, used > 0 ? 1 : 0)}%` }} />
      </div>
      {warn && <p className="text-xs text-amber-700 dark:text-amber-300">Close to the free limit.</p>}
      {note && <p className="text-xs text-neutral-500">{note}</p>}
    </div>
  );
}

export function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Usage>("/api/usage").then(setUsage).catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not load usage"));
  }, []);

  return (
    <section className="min-w-0 flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Usage</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Free-tier limits for the whole team. A warning shows from 80%.</p>
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
        {!usage && !error && <p className="text-sm text-neutral-400">Loading…</p>}
        {usage && (
          <>
            <div className="space-y-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
              <h2 className="font-medium">Sending (Resend free plan)</h2>
              <Meter label="Recipients today (QuadMail limit)" used={usage.sentToday} limit={usage.dailyLimit} note="Every To, Cc and Bcc address counts. Resets at midnight UTC." />
              <Meter label="Emails this month (Resend)" used={usage.sentThisMonth} limit={usage.providerMonthlyLimit} />
            </div>
            <div className="space-y-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
              <h2 className="font-medium">Storage (Cloudflare free plan)</h2>
              <Meter label="Database (D1)" used={usage.d1Bytes} limit={usage.d1LimitBytes} format={formatBytes} />
              <Meter label="Mail files (R2), estimated" used={usage.r2Bytes} limit={usage.r2LimitBytes} format={formatBytes} />
              <p className="text-xs text-neutral-500">
                {usage.messages} messages in total. Trash and Spam are emptied automatically {usage.retentionDays} days after a message is moved there.
              </p>
            </div>
            <div className="space-y-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
              <h2 className="font-medium">Messages per user</h2>
              <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
                {usage.perUser.map((u) => (
                  <li key={u.email} className="flex justify-between py-1.5">
                    <span>{u.email}</span>
                    <span className="text-neutral-500">{u.messages}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
