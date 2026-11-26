import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { derivePasswordKey } from "./kdf";

export const MIN_PASSWORD_LENGTH = 10;

/** Change your own password. `forced`: full screen after an admin created the account or reset it. */
export function ChangePassword({ email, forced = false, onDone, onSignOut }: { email: string; forced?: boolean; onDone: () => void; onSignOut?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (next.length < MIN_PASSWORD_LENGTH) return setMessage({ ok: false, text: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
    if (next !== repeat) return setMessage({ ok: false, text: "The new passwords do not match." });
    if (next === current) return setMessage({ ok: false, text: "Choose a password different from the current one." });
    setBusy(true);
    try {
      const [currentKey, newKey] = await Promise.all([derivePasswordKey(email, current), derivePasswordKey(email, next)]);
      await api("/api/auth/password", { body: { currentKey, newKey } });
      setCurrent("");
      setNext("");
      setRepeat("");
      setMessage({ ok: true, text: "Password changed. Other devices were signed out." });
      onDone();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not change the password" });
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";
  const form = (
    <form onSubmit={submit} className="space-y-2">
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.ok ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"}`}>
          {message.text}
        </p>
      )}
      <input className={input} type="password" autoComplete="current-password" placeholder={forced ? "Temporary password from your admin" : "Current password"} required value={current} onChange={(e) => setCurrent(e.target.value)} />
      <input className={input} type="password" autoComplete="new-password" placeholder={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`} required value={next} onChange={(e) => setNext(e.target.value)} />
      <input className={input} type="password" autoComplete="new-password" placeholder="Repeat new password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      <button disabled={busy} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
        {busy ? "Saving…" : "Change password"}
      </button>
    </form>
  );

  if (!forced) return form;
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-100 p-4 dark:bg-neutral-950">
      <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">Choose your password</h1>
          <p className="text-sm text-neutral-500">Welcome, {email}. Your admin gave you a temporary password; set your own before you continue.</p>
        </div>
        {form}
        {onSignOut && <button onClick={onSignOut} className="text-xs text-neutral-500 hover:underline">Sign out</button>}
      </div>
    </main>
  );
}
