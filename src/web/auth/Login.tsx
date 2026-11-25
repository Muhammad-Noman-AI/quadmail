import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { derivePasswordKey } from "./kdf";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [passwordKey, setPasswordKey] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      // The slow, brute-force-resistant step runs here, not on the Worker (see kdf.ts).
      const key = passwordKey ?? (await derivePasswordKey(email, password));
      setPasswordKey(key);
      await api("/api/auth/login", { body: { email, passwordKey: key, totp: needsCode ? code : undefined } });
      setPassword("");
      onSignedIn();
    } catch (err) {
      if (err instanceof ApiError && err.body.totpRequired) {
        setNeedsCode(true);
      } else {
        setMessage(err instanceof ApiError ? err.message : "Could not reach the server");
        if (!(err instanceof ApiError && err.status === 401 && needsCode)) setPasswordKey(null);
      }
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-100 p-4 dark:bg-neutral-950">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">QuadMail</h1>
          <p className="text-sm text-neutral-500">{needsCode ? "Enter the 6-digit code from your authenticator app." : "Sign in to your mailbox."}</p>
        </div>
        {!needsCode ? (
          <>
            <label className="block space-y-1 text-sm">
              <span className="text-neutral-700 dark:text-neutral-300">Email</span>
              <input className={input} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-neutral-700 dark:text-neutral-300">Password</span>
              <input
                className={input}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordKey(null);
                }}
              />
            </label>
          </>
        ) : (
          <label className="block space-y-1 text-sm">
            <span className="text-neutral-700 dark:text-neutral-300">Authentication code</span>
            <input
              className={`${input} tracking-[0.3em]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
        {message && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{message}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
          {busy ? "Signing in…" : needsCode ? "Verify" : "Sign in"}
        </button>
        {needsCode && (
          <button
            type="button"
            className="w-full text-sm text-neutral-500 hover:underline"
            onClick={() => {
              setNeedsCode(false);
              setCode("");
              setPasswordKey(null);
            }}
          >
            Back
          </button>
        )}
      </form>
    </main>
  );
}
