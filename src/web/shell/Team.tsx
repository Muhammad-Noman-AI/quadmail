// Admin page: create users and see/manage the whole team in one place.
import { useEffect, useState, type FormEvent } from "react";
import type { Role, SendingInfo, TeamMember } from "../../shared/types";
import { api, ApiError, type Me } from "../api";
import { MIN_PASSWORD_LENGTH } from "../auth/ChangePassword";
import { derivePasswordKey } from "../auth/kdf";

const input = "rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const link = "text-xs text-blue-600 hover:underline disabled:opacity-50";

/** 14 characters from an unambiguous alphabet (no 0/O, 1/l/I): easy to read out or type. */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function MemberRow({ member, me, domain, onChanged, onMessage }: { member: TeamMember; me: Me; domain: string; onChanged: () => void; onMessage: (ok: boolean, text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [alias, setAlias] = useState("");
  const [adding, setAdding] = useState(false);
  const self = member.id === me.id;

  async function run(task: () => Promise<string | void>) {
    setBusy(true);
    try {
      const text = await task();
      if (text) onMessage(true, text);
      onChanged();
    } catch (err) {
      onMessage(false, err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const patch = (body: Record<string, unknown>, done: string) => run(async () => {
    await api(`/api/team/${member.id}`, { method: "PATCH", body });
    return done;
  });

  async function resetPassword() {
    if (!window.confirm(`Reset the password of ${member.email}? They are signed out everywhere and must choose a new password at the next login.`)) return;
    const sendTo = member.recoveryEmail && window.confirm(`Email the new temporary password to ${member.recoveryEmail}?`) ? member.recoveryEmail : null;
    const temp = generatePassword();
    await run(async () => {
      const result = await api<{ emailed: { sent: boolean; error?: string } }>(`/api/team/${member.id}`, {
        method: "PATCH",
        body: { passwordKey: await derivePasswordKey(member.email, temp), ...(sendTo ? { tempPassword: temp } : {}) },
      });
      if (sendTo && result.emailed.sent) return `New temporary password sent to ${sendTo}. (It is also: ${temp})`;
      const failed = sendTo ? ` The email to ${sendTo} failed: ${result.emailed.error ?? "unknown error"}.` : "";
      return `New temporary password for ${member.email}: ${temp} — give it to them privately. It is shown only once.${failed}`;
    });
  }

  async function editRecovery() {
    const value = window.prompt(`Personal email of ${member.email} (for sign-in details). Leave empty to remove.`, member.recoveryEmail ?? "");
    if (value === null) return;
    await patch({ recoveryEmail: value.trim() || null }, value.trim() ? `Personal email saved: ${value.trim()}` : "Personal email removed.");
  }

  async function addAlias(event: FormEvent) {
    event.preventDefault();
    const address = alias.includes("@") ? alias.trim() : `${alias.trim()}@${domain}`;
    await run(async () => {
      await api(`/api/team/${member.id}/addresses`, { body: { address } });
      setAlias("");
      setAdding(false);
      return `${address} now delivers to ${member.email}.`;
    });
  }

  return (
    <li className={`space-y-2 px-4 py-3 ${member.disabled ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">
            {member.displayName || member.email}
            {self && <span className="ml-2 text-xs text-neutral-500">(you)</span>}
          </div>
          <div className="text-sm text-neutral-600 dark:text-neutral-400">{member.email}</div>
          <div className="text-xs text-neutral-500">
            Personal email: {member.recoveryEmail ?? <span className="text-neutral-400">not set</span>}{" "}
            <button className={link} onClick={editRecovery} disabled={busy}>{member.recoveryEmail ? "Edit" : "Add"}</button>
          </div>
          <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
            <span className={`rounded px-1.5 ${member.role === "admin" ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200" : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"}`}>{member.role}</span>
            {member.disabled ? (
              <span className="rounded bg-red-100 px-1.5 text-red-700 dark:bg-red-950 dark:text-red-300">disabled</span>
            ) : (
              <span className="rounded bg-green-100 px-1.5 text-green-800 dark:bg-green-950 dark:text-green-200">active</span>
            )}
            {member.mustChangePassword && <span className="rounded bg-amber-100 px-1.5 text-amber-800 dark:bg-amber-950 dark:text-amber-200">first login pending</span>}
            {member.totpEnabled && <span className="rounded bg-neutral-100 px-1.5 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">2FA on</span>}
          </div>
        </div>
        {!self && (
          <div className="flex flex-wrap gap-3">
            <button disabled={busy} className={link} onClick={resetPassword}>Reset password</button>
            <button disabled={busy} className={link} onClick={() => patch({ role: member.role === "admin" ? "member" : "admin" }, `${member.email} is now ${member.role === "admin" ? "a member" : "an admin"}.`)}>
              {member.role === "admin" ? "Make member" : "Make admin"}
            </button>
            <button
              disabled={busy}
              className={`text-xs hover:underline disabled:opacity-50 ${member.disabled ? "text-green-700" : "text-red-600"}`}
              onClick={() => {
                if (!member.disabled && !window.confirm(`Disable ${member.email}? They are signed out and cannot log in. New mail to their addresses goes to the admin. Nothing is deleted.`)) return;
                void patch({ disabled: !member.disabled }, `${member.email} is ${member.disabled ? "active again" : "disabled"}.`);
              }}
            >
              {member.disabled ? "Enable" : "Disable"}
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-neutral-500">Extra addresses:</span>
        {member.addresses.length === 0 && <span className="text-neutral-400">none</span>}
        {member.addresses.map((a) => (
          <span key={a.id} className="flex items-center gap-1 rounded-full border border-neutral-200 px-2 py-0.5 dark:border-neutral-700">
            {a.address}
            <button
              aria-label={`Remove ${a.address}`}
              className="text-neutral-400 hover:text-red-600"
              onClick={() => run(async () => {
                await api(`/api/team/${member.id}/addresses/${a.id}`, { method: "DELETE" });
                return `${a.address} removed. Its mail now goes to the admin (catch-all).`;
              })}
            >
              ×
            </button>
          </span>
        ))}
        {adding ? (
          <form onSubmit={addAlias} className="flex items-center gap-1">
            <input autoFocus className={`${input} py-0.5 text-xs`} placeholder={`sales or sales@${domain}`} value={alias} onChange={(e) => setAlias(e.target.value)} />
            <button className={link}>Add</button>
            <button type="button" className="text-xs text-neutral-500 hover:underline" onClick={() => setAdding(false)}>Cancel</button>
          </form>
        ) : (
          <button className={link} onClick={() => setAdding(true)}>+ Add address</button>
        )}
      </div>
    </li>
  );
}

export function Team({ me }: { me: Me }) {
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [domain, setDomain] = useState("");
  const [local, setLocal] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [password, setPassword] = useState(generatePassword);
  const [personal, setPersonal] = useState("");
  const [sendDetails, setSendDetails] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api<{ items: TeamMember[] }>("/api/team").then((r) => setTeam(r.items)).catch((err: unknown) => setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not load the team" }));
  useEffect(() => {
    void load();
    api<SendingInfo>("/api/sending").then((info) => setDomain(info.allowedDomains[0] ?? "")).catch(() => {});
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const email = `${local.trim().toLowerCase()}@${domain}`;
    if (password.length < MIN_PASSWORD_LENGTH) return setMessage({ ok: false, text: `The temporary password needs at least ${MIN_PASSWORD_LENGTH} characters.` });
    const recovery = personal.trim().toLowerCase();
    if (recovery && recovery === email) return setMessage({ ok: false, text: "The personal email must be a different address (for example their Gmail)." });
    const emailIt = !!recovery && sendDetails;
    setBusy(true);
    try {
      const result = await api<{ invite: { sent: boolean; error?: string } }>("/api/team", {
        body: {
          email,
          displayName: name.trim() || null,
          role,
          passwordKey: await derivePasswordKey(email, password),
          recoveryEmail: recovery || null,
          ...(emailIt ? { tempPassword: password } : {}),
        },
      });
      if (emailIt && result.invite.sent) {
        setMessage({ ok: true, text: `Created ${email}. The sign-in details were emailed to ${recovery}. (Temporary password, in case they need it: ${password})` });
      } else {
        const failed = emailIt ? ` The email to ${recovery} could not be sent: ${result.invite.error ?? "unknown error"}.` : "";
        setMessage({ ok: !failed, text: `Created ${email}. Give them the app address and this temporary password privately: ${password} — they choose their own at the first login.${failed}` });
      }
      setLocal("");
      setName("");
      setRole("member");
      setPersonal("");
      setSendDetails(true);
      setPassword(generatePassword());
      void load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not create the user" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="min-w-0 flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold">Team</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Everyone who can sign in to QuadMail. Each person sees only their own mail. Mail to an address nobody owns goes to the admin.
          </p>
        </div>

        {message && (
          <p role="status" className={`select-text break-words rounded-lg px-3 py-2 text-sm ${message.ok ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"}`}>
            {message.text}
          </p>
        )}

        <form onSubmit={create} className="space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Add a user</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center">
              <input className={`${input} w-40 rounded-r-none`} required placeholder="ali" pattern="[A-Za-z0-9._%+\-]+" value={local} onChange={(e) => setLocal(e.target.value)} aria-label="Email name" />
              <span className="rounded-r-lg border border-l-0 border-neutral-300 bg-neutral-100 px-3 py-1.5 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">@{domain || "…"}</span>
            </div>
            <input className={input} placeholder="Full name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            <select className={input} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${input} w-56 font-mono`} required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Temporary password" />
            <button type="button" className={link} onClick={() => setPassword(generatePassword())}>Generate new</button>
            <span className="text-xs text-neutral-500">Temporary password: they must change it at the first login.</span>
          </div>
          <div className="space-y-2 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900">
            <div className="text-sm font-medium">Send sign-in details <span className="font-normal text-neutral-500">(optional)</span></div>
            <p className="text-xs text-neutral-500">
              Their personal email, like a Gmail address. We email them their new address, the temporary password and the sign-in link. Leave it empty to skip and give the details yourself.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <input className={`${input} w-72`} type="email" placeholder="ubaid.personal@gmail.com" value={personal} onChange={(e) => setPersonal(e.target.value)} aria-label="Personal email" />
              {personal.trim() && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={sendDetails} onChange={(e) => setSendDetails(e.target.checked)} />
                  Email the sign-in details now
                </label>
              )}
            </div>
          </div>
          <button disabled={busy || !domain} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
            {busy ? "Creating…" : "Create user"}
          </button>
        </form>

        <div className="space-y-2">
          <h2 className="font-medium">Members {team ? `(${team.length})` : ""}</h2>
          {!team ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : (
            <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {team.map((member) => (
                <MemberRow key={member.id} member={member} me={me} domain={domain} onChanged={load} onMessage={(ok, text) => setMessage({ ok, text })} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
