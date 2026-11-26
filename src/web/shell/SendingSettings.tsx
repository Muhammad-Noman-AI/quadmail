// Settings → identities (From addresses, names, signatures) and suppressed recipients.
import { useEffect, useState, type FormEvent } from "react";
import type { Identity, SendingInfo } from "../../shared/types";
import { api, ApiError, type Me } from "../api";
import { textToHtml } from "../compose/html";
import { htmlToText } from "../mail/text";

interface Suppression {
  address: string;
  reason: string;
  createdAt: number;
}

const input = "rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const link = "text-xs text-blue-600 hover:underline";

function IdentityRow({ identity, canRemove, removePath, onSaved, onError }: { identity: Identity; canRemove: boolean; removePath: string; onSaved: () => void; onError: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(identity.displayName ?? "");
  const [signature, setSignature] = useState(() => htmlToText(identity.signatureHtml ?? "").trim());

  async function call(path: string, method: string, body?: unknown) {
    try {
      await api(path, { method, body });
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    // The signature is edited as plain text and stored as escaped HTML.
    await call(`/api/identities/${identity.id}`, "PATCH", { displayName: name.trim() || null, signatureHtml: signature.trim() ? textToHtml(signature.trim()) : null });
    setEditing(false);
  }

  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {identity.displayName ? `${identity.displayName} <${identity.address}>` : identity.address}
          {identity.isDefault && <span className="ml-2 rounded bg-blue-100 px-1.5 text-xs text-blue-800 dark:bg-blue-950 dark:text-blue-200">default</span>}
        </span>
        <span className="flex gap-3">
          <button className={link} onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : "Edit"}</button>
          {!identity.isDefault && <button className={link} onClick={() => call(`/api/identities/${identity.id}`, "PATCH", { isDefault: true })}>Make default</button>}
          {!identity.isDefault && canRemove && <button className="text-xs text-red-600 hover:underline" onClick={() => call(removePath, "DELETE")}>Remove</button>}
        </span>
      </div>
      {editing && (
        <form onSubmit={save} className="space-y-2">
          <input className={`${input} w-full`} placeholder="Display name (e.g. Noman Ahmed)" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className={`${input} w-full`} rows={4} placeholder="Signature" maxLength={2000} value={signature} onChange={(e) => setSignature(e.target.value)} />
          <button className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">Save</button>
        </form>
      )}
    </li>
  );
}

export function SendingSettings({ me }: { me: Me }) {
  const isAdmin = me.role === "admin";
  const [info, setInfo] = useState<SendingInfo | null>(null);
  const [suppressed, setSuppressed] = useState<Suppression[]>([]);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api<SendingInfo>("/api/sending").then(setInfo).catch(() => {});
    api<{ items: Suppression[] }>("/api/suppressions").then((r) => setSuppressed(r.items)).catch(() => {});
  };
  useEffect(load, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api(`/api/team/${me.id}/addresses`, { body: { address: address.trim() } });
      setAddress("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the address");
    }
  }

  async function unsuppress(entry: Suppression) {
    try {
      await api(`/api/suppressions/${encodeURIComponent(entry.address)}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove it");
    }
  }

  return (
    <>
      <div className="space-y-2">
        <h2 className="font-medium">Sending</h2>
        {info && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {info.providerReady ? "Resend is connected." : "Resend is not connected yet."} Sent today: {info.sentToday} of {info.dailyLimit}.
          </p>
        )}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
          {info?.identities.map((identity) => (
            <IdentityRow
              key={`${identity.id}:${identity.displayName}:${identity.signatureHtml}`}
              identity={identity}
              canRemove={isAdmin && identity.address.toLowerCase() !== me.email.toLowerCase()}
              removePath={`/api/team/${me.id}/addresses/${identity.id}`}
              onSaved={load}
              onError={setError}
            />
          ))}
        </ul>
        {!isAdmin && <p className="text-xs text-neutral-500">To get another address (like sales@), ask your admin.</p>}
        {isAdmin && <form onSubmit={add} className="flex flex-wrap gap-2">
          <input className={input} type="email" required placeholder={`sales@${info?.allowedDomains[0] ?? "example.com"}`} value={address} onChange={(e) => setAddress(e.target.value)} />
          <button className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">Add address</button>
        </form>}
      </div>

      <div className="space-y-2">
        <h2 className="font-medium">Suppressed addresses</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Mail to these is refused because it bounced or the recipient marked it as spam.</p>
        {suppressed.length ? (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
            {suppressed.map((entry) => (
              <li key={entry.address} className="flex items-center justify-between px-3 py-2">
                <span>
                  {entry.address} <span className="text-xs text-neutral-500">({entry.reason})</span>
                </span>
                <button className={link} onClick={() => unsuppress(entry)}>Remove</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">None.</p>
        )}
      </div>
    </>
  );
}
