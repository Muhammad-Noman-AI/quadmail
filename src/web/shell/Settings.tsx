import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "../api";
import { derivePasswordKey } from "../auth/kdf";
import { ChangePassword } from "../auth/ChangePassword";
import { setThemeChoice, themeChoice, type ThemeChoice } from "../theme";
import { DomainSettings } from "./DomainSettings";
import { SendingSettings } from "./SendingSettings";

interface Blocked {
  address: string;
  createdAt: number;
}

export function Settings({ me, onChanged, onSignedOut }: { me: Me; onChanged: () => void; onSignedOut: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<Blocked[]>([]);

  const loadBlocked = () => api<{ items: Blocked[] }>("/api/blocked-senders").then((r) => setBlocked(r.items)).catch(() => {});
  useEffect(() => {
    loadBlocked();
  }, []);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await task();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Something went wrong" });
    } finally {
      setBusy(false);
    }
  }

  const startSetup = () => run(async () => setSetup(await api<{ secret: string; uri: string }>("/api/auth/totp/setup", { method: "POST" })));

  const enable = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      await api("/api/auth/totp/enable", { body: { secret: setup!.secret, code } });
      setSetup(null);
      setCode("");
      setMessage({ ok: true, text: "Two-factor login is on." });
      onChanged();
    });
  };

  const disable = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      await api("/api/auth/totp/disable", { body: { passwordKey: await derivePasswordKey(me.email, password), code } });
      setPassword("");
      setCode("");
      setMessage({ ok: true, text: "Two-factor login is off." });
      onChanged();
    });
  };

  const logoutAll = () =>
    run(async () => {
      await api("/api/auth/logout-all", { method: "POST" });
      onSignedOut();
    });

  const input = "rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";
  const primary = "rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60";

  return (
    <section className="min-w-0 flex-1 overflow-y-auto p-6">
      <div className="max-w-xl space-y-8">
        <h1 className="text-xl font-semibold">Settings</h1>
        {message && (
          <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.ok ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"}`}>
            {message.text}
          </p>
        )}

        <div className="space-y-2">
          <h2 className="font-medium">Appearance</h2>
          <select className={input} defaultValue={themeChoice()} onChange={(e) => setThemeChoice(e.target.value as ThemeChoice)} aria-label="Theme">
            <option value="system">Same as my device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <SendingSettings me={me} />

        {me.role === "admin" && <DomainSettings />}

        <div className="space-y-2">
          <h2 className="font-medium">Password</h2>
          <ChangePassword email={me.email} onDone={() => {}} />
        </div>

        <div className="space-y-3">
          <h2 className="font-medium">Two-factor login</h2>
          {me.totpEnabled ? (
            <form onSubmit={disable} className="space-y-2">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">On. To turn it off, enter your password and a current code.</p>
              <div className="flex flex-wrap gap-2">
                <input className={input} type="password" autoComplete="current-password" placeholder="Password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                <input className={input} inputMode="numeric" maxLength={6} placeholder="123456" required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                <button disabled={busy} className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300">Turn off</button>
              </div>
            </form>
          ) : setup ? (
            <form onSubmit={enable} className="space-y-2 text-sm">
              <p className="text-neutral-600 dark:text-neutral-400">
                In Google Authenticator, Microsoft Authenticator or 1Password, add an account with this setup key, then enter the 6-digit code it shows.
              </p>
              <code className="block select-all break-all rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              <a href={setup.uri} className="text-blue-600 hover:underline">Open in authenticator app (on this device)</a>
              <div className="flex gap-2">
                <input className={input} inputMode="numeric" maxLength={6} placeholder="123456" required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                <button disabled={busy} className={primary}>Turn on</button>
              </div>
            </form>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">Off. Turn it on so a stolen password is not enough to read your mail.</p>
              <button disabled={busy} onClick={startSetup} className={primary}>Set up</button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h2 className="font-medium">Sessions</h2>
          <button disabled={busy} onClick={logoutAll} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
            Sign out everywhere
          </button>
        </div>

        <div className="space-y-2">
          <h2 className="font-medium">Blocked senders</h2>
          {blocked.length ? (
            <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
              {blocked.map((b) => (
                <li key={b.address} className="flex items-center justify-between px-3 py-2">
                  {b.address}
                  <button
                    className="text-xs text-blue-600 hover:underline"
                    onClick={() => run(async () => { await api(`/api/blocked-senders/${encodeURIComponent(b.address)}`, { method: "DELETE" }); await loadBlocked(); })}
                  >
                    Unblock
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">Nobody is blocked.</p>
          )}
        </div>
      </div>
    </section>
  );
}
