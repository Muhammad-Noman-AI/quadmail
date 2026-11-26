// Settings → Domains & sending (admin): domains, daily limit, Resend key.
import { useEffect, useState, type FormEvent } from "react";
import type { DnsReport, SendingSettingsInfo, SetupDomain } from "../../shared/types";
import { api, ApiError } from "../api";
import { Badge, CheckRow, RecordsTable } from "../setup/Wizard";

const input = "rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const button = "rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";
const envNote = "text-xs text-neutral-500";

export function DomainSettings() {
  const [info, setInfo] = useState<SendingSettingsInfo | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [key, setKey] = useState("");
  const [pending, setPending] = useState<SetupDomain | null>(null);
  const [dns, setDns] = useState<DnsReport | null>(null);
  const [limit, setLimit] = useState("");
  const [replaceKey, setReplaceKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () =>
    api<SendingSettingsInfo>("/api/admin/sending")
      .then((i) => {
        setInfo(i);
        setLimit(String(i.dailyLimit));
      })
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  async function run(task: () => Promise<string | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await task();
      if (text) setMessage({ ok: true, text });
      await load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Something went wrong" });
    } finally {
      setBusy(false);
    }
  }

  if (!info) return null;

  const startAdd = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setPending(await api<SetupDomain>("/api/admin/domains", { body: { domain: newDomain.trim(), apiKey: key.trim() } }));
      setKey("");
      setDns(null);
    });
  };
  const check = () =>
    run(async () => {
      const result = await api<{ added: boolean; domain: SetupDomain; dns: DnsReport | null }>("/api/admin/domains/verify", { method: "POST" });
      setDns(result.dns);
      if (!result.added) {
        setPending(result.domain);
        return;
      }
      setPending(null);
      setNewDomain("");
      return `${result.domain.name} is verified and can be used for addresses now (Team → Add address).`;
    });

  return (
    <div className="space-y-3">
      <h2 className="font-medium">Domains &amp; sending</h2>
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.ok ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"}`}>
          {message.text}
        </p>
      )}

      <div className="space-y-2">
        <div className="text-sm text-neutral-600 dark:text-neutral-400">Email domains</div>
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
          {info.domains.map((d) => (
            <li key={d} className="flex items-center justify-between px-3 py-2">
              {d}
              {!info.domainsFromEnv && info.domains.length > 1 && (
                <button
                  className="text-xs text-red-600 hover:underline"
                  onClick={() => {
                    if (window.confirm(`Stop using ${d}? Nobody can send from it any more. Mail already stored stays.`)) {
                      void run(async () => {
                        await api(`/api/admin/domains/${encodeURIComponent(d)}`, { method: "DELETE" });
                        return `${d} removed.`;
                      });
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {info.domainsFromEnv ? (
          <p className={envNote}>Set by the ALLOWED_SENDING_DOMAINS variable on this installation; change it there.</p>
        ) : pending ? (
          <div className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <p className="text-sm">
              Add these records in Cloudflare (<b>{pending.name} → DNS → Records</b>, DNS only), then press Check. Resend: <Badge status={pending.status} />
            </p>
            <RecordsTable records={pending.records} />
            <div className="flex gap-2">
              <button disabled={busy} className={button} onClick={check}>{busy ? "Checking…" : "Check"}</button>
              <button disabled={busy} className="text-sm text-neutral-500 hover:underline" onClick={() => run(async () => { await api("/api/admin/domains/pending", { method: "DELETE" }); setPending(null); })}>
                Cancel
              </button>
            </div>
            {dns && (
              <ul className="space-y-1">
                <CheckRow label="SPF" check={dns.spf} />
                <CheckRow label="DMARC" check={dns.dmarc} />
                <CheckRow label="Receiving (MX)" check={dns.mx} />
              </ul>
            )}
          </div>
        ) : (
          <form onSubmit={startAdd} className="flex flex-wrap gap-2">
            <input className={input} required placeholder="another-domain.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} aria-label="New domain" />
            <input className={`${input} font-mono`} type="password" required placeholder="Resend key with Full access (re_...)" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Resend full-access key" />
            <button disabled={busy} className={button}>{busy ? "Adding…" : "Add domain"}</button>
            <p className={`${envNote} w-full`}>The domain must be on Cloudflare in this account. The key is used for this change only. Resend Free allows 3 domains.</p>
          </form>
        )}
        {info.pendingDomain && !pending && !info.domainsFromEnv && (
          <p className={envNote}>
            {info.pendingDomain} is waiting for verification.{" "}
            <button className="text-blue-600 hover:underline" onClick={check}>Check now</button>
          </p>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-sm text-neutral-600 dark:text-neutral-400">Daily limit (recipients per day; Resend Free allows 100)</div>
        {info.limitFromEnv ? (
          <p className="text-sm">{info.dailyLimit} <span className={envNote}>(set by the DAILY_SEND_LIMIT variable)</span></p>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("/api/admin/sending", { method: "PATCH", body: { dailyLimit: Number(limit) } });
                return `Daily limit is now ${limit}.`;
              });
            }}
          >
            <input className={`${input} w-24`} type="number" min={1} max={100} required value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Daily limit" />
            <button disabled={busy} className={button}>Save</button>
          </form>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-sm text-neutral-600 dark:text-neutral-400">Resend key {info.providerReady ? "(connected)" : "(not connected)"}</div>
        {info.keyFromEnv ? (
          <p className={envNote}>Set by the RESEND_API_KEY secret on this installation.</p>
        ) : (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("/api/admin/resend-key", { body: { apiKey: replaceKey.trim() } });
                setReplaceKey("");
                return "A new sending-only key is in use. You can revoke the old one in Resend.";
              });
            }}
          >
            <input className={`${input} font-mono`} type="password" required placeholder="Full-access key (re_...)" value={replaceKey} onChange={(e) => setReplaceKey(e.target.value)} aria-label="Resend full-access key for replacement" />
            <button disabled={busy} className={button}>Replace key</button>
          </form>
        )}
      </div>
    </div>
  );
}
