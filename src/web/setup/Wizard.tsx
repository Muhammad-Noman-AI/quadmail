// First-run setup wizard (docs/SELF-SETUP-PLAN.md). Steps 1–2 run before any user exists; the rest
// as the new admin. The server decides what is allowed; this screen only guides.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DnsCheck, DnsReport, SetupDomain, SetupStatus } from "../../shared/types";
import { api, ApiError } from "../api";
import { MIN_PASSWORD_LENGTH } from "../auth/ChangePassword";
import { derivePasswordKey } from "../auth/kdf";

const STEPS = ["Unlock", "Organisation", "Resend", "DNS", "Sending", "Receiving", "Test", "Done"];
const input = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";
const primary = "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60";
const secondary = "rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";
const link = "text-blue-600 underline hover:text-blue-700";

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function Badge({ status }: { status: string }) {
  const ok = status === "verified" || status === "ok";
  const bad = status === "failed" || status === "fail" || status === "partially_failed";
  const color = ok
    ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200"
    : bad
      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
      : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${color}`}>{status.replace(/_/g, " ")}</span>;
}

/** DNS records to add, with copy buttons and per-record status. Also used in Settings. */
export function RecordsTable({ records }: { records: SetupDomain["records"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-neutral-500">
          <tr>
            <th className="py-1 pr-2">Type</th>
            <th className="py-1 pr-2">Name</th>
            <th className="py-1 pr-2">Value</th>
            <th className="py-1 pr-2">Priority</th>
            <th className="py-1">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {records.map((r, i) => (
            <tr key={`${r.type}-${r.name}-${i}`} className="align-top">
              <td className="py-2 pr-2 font-mono">{r.type}</td>
              <td className="py-2 pr-2">
                <div className="flex items-start gap-1">
                  <code className="break-all">{r.name}</code>
                  <Copy value={r.name} />
                </div>
              </td>
              <td className="py-2 pr-2">
                <div className="flex items-start gap-1">
                  <code className="max-w-[16rem] break-all text-xs">{r.value}</code>
                  <Copy value={r.value} />
                </div>
              </td>
              <td className="py-2 pr-2">{r.priority ?? ""}</td>
              <td className="py-2">
                <Badge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CheckRow({ label, check }: { label: string; check: DnsCheck }) {
  const icon = check.status === "ok" ? "✓" : check.status === "fail" ? "✕" : "!";
  const color = check.status === "ok" ? "text-green-700 dark:text-green-300" : check.status === "fail" ? "text-red-600 dark:text-red-300" : "text-amber-700 dark:text-amber-300";
  return (
    <li className="flex gap-2 text-sm">
      <span className={`w-4 shrink-0 font-bold ${color}`}>{icon}</span>
      <span>
        <b>{label}:</b> {check.message}
      </span>
    </li>
  );
}

function Shell({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-neutral-100 px-4 py-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="text-lg font-semibold">Set up QuadMail</span>
        </div>
        <ol className="flex flex-wrap gap-1 text-xs" aria-label="Setup steps">
          {STEPS.map((name, i) => (
            <li
              key={name}
              aria-current={i === step ? "step" : undefined}
              className={`rounded-full px-2.5 py-1 ${i < step ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200" : i === step ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800"}`}
            >
              {i + 1}. {name}
            </li>
          ))}
        </ol>
        <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
          <h1 className="text-xl font-semibold">{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

function ErrorNote({ text }: { text: string | null }) {
  return text ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{text}</p> : null;
}

/** Steps 1–2: setup code, organisation and the first admin. */
function CreateAdmin({ codeConfigured, onCreated }: { codeConfigured: boolean; onCreated: () => void }) {
  const [code, setCode] = useState("");
  const [orgName, setOrgName] = useState("");
  const [domain, setDomain] = useState("");
  const [local, setLocal] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

  if (!codeConfigured) {
    return (
      <Shell step={0} title="Add a setup code first">
        <p className="text-sm">
          This QuadMail has no setup code yet, so nobody can claim it. In Cloudflare open <b>Workers &amp; Pages → your QuadMail Worker → Settings → Variables and secrets</b>, add a
          secret named <code>SETUP_CODE</code> (any phrase of 8 or more characters only you know), then reload this page.
        </p>
      </Shell>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) return setError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (password !== repeat) return setError("The passwords do not match.");
    const email = `${local.trim().toLowerCase()}@${cleanDomain}`;
    setBusy(true);
    try {
      await api("/api/setup/admin", { body: { code, orgName, domain: cleanDomain, email, displayName: name.trim() || null, passwordKey: await derivePasswordKey(email, password) } });
      onCreated();
    } catch (err) {
      setError(errorText(err, "Could not create the admin"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell step={code ? 1 : 0} title="Welcome! Let's set up your email">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">This takes about 20 minutes. You need your domain on Cloudflare and a free Resend account.</p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Setup code</span>
          <input className={input} type="password" autoComplete="off" required value={code} onChange={(e) => setCode(e.target.value)} />
          <span className="text-xs text-neutral-500">The code you chose when you deployed QuadMail.</span>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Organisation name</span>
          <input className={input} required maxLength={100} placeholder="Acme Ltd" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Email domain</span>
          <input className={input} required placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
          <span className="text-xs text-neutral-500">The domain on Cloudflare that your addresses will use.</span>
        </label>
        <div className="space-y-1 text-sm">
          <span className="font-medium">Your admin address</span>
          <div className="flex items-center">
            <input className={`${input} rounded-r-none`} required pattern="[A-Za-z0-9._%+\-]+" placeholder="you" value={local} onChange={(e) => setLocal(e.target.value)} aria-label="Address name" />
            <span className="rounded-r-lg border border-l-0 border-neutral-300 bg-neutral-100 px-3 py-2 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">@{cleanDomain || "your-domain"}</span>
          </div>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Your name</span>
          <input className={input} maxLength={100} placeholder="Optional" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <input className={input} type="password" autoComplete="new-password" required placeholder={`Password (${MIN_PASSWORD_LENGTH}+ characters)`} value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className={input} type="password" autoComplete="new-password" required placeholder="Repeat password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </div>
        <ErrorNote text={error} />
        <button disabled={busy} className={primary}>{busy ? "Creating… (a few seconds)" : "Create organisation"}</button>
      </form>
    </Shell>
  );
}

/** Steps 3–8, as the new admin. */
function Configure({ status, reload }: { status: SetupStatus; reload: () => Promise<void> }) {
  const [domainInfo, setDomainInfo] = useState<SetupDomain | null>(null);
  const [dns, setDns] = useState<DnsReport | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState<string[] | null>(null);
  const [later, setLater] = useState<"receiving" | "test" | "done">(status.inboundVerified ? "test" : "receiving");
  const [testTo, setTestTo] = useState("");
  const [testSent, setTestSent] = useState(false);
  const [inbound, setInbound] = useState<{ address: string | null; received: boolean }>({ address: status.inboundTestAddress, received: status.inboundVerified });
  const domain = status.domain ?? "";

  const needsKey = !status.sendingReady && (!status.resendConnected || !status.setupKeyHeld);
  const step = needsKey ? 2 : !status.sendingReady ? (domainInfo?.status === "verified" ? 4 : 3) : later === "receiving" ? 5 : later === "test" ? 6 : 7;

  // Records of a connected domain, e.g. after a reload in the DNS step.
  useEffect(() => {
    if (!needsKey && !status.sendingReady && !domainInfo) {
      api<SetupDomain>("/api/setup/domain")
        .then(setDomainInfo)
        .catch((err: unknown) => setError(errorText(err, "Could not load the domain")));
    }
  }, [needsKey, status.sendingReady, domainInfo]);

  // Waiting for the inbound test mail.
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (step !== 5 || !inbound.address || inbound.received) return;
    polling.current = setInterval(() => {
      api<{ address: string | null; received: boolean }>("/api/setup/inbound-test").then(setInbound).catch(() => {});
    }, 5000);
    return () => {
      if (polling.current) clearInterval(polling.current);
    };
  }, [step, inbound.address, inbound.received]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(errorText(err, "Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  if (step === 2) {
    return (
      <Shell step={2} title="Connect Resend (for sending)">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>
            Sign in at{" "}
            <a className={link} href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer">
              resend.com/api-keys
            </a>{" "}
            (free account).
          </li>
          <li>
            <b>Create API key</b> → permission <b>Full access</b> → copy it.
          </li>
          <li>Paste it below. QuadMail uses it once to add {domain} and the webhook, then replaces it with a key that can only send. It is not kept.</li>
        </ol>
        {status.resendConnected && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">For your security the key is only kept for 2 hours. Paste it again to continue.</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setDomainInfo(await api<SetupDomain>("/api/setup/resend", { body: { apiKey: key.trim() } }));
              setKey("");
              await reload();
            });
          }}
          className="flex flex-wrap gap-2"
        >
          <input className={`${input} flex-1 font-mono`} type="password" autoComplete="off" required placeholder="re_..." value={key} onChange={(e) => setKey(e.target.value)} />
          <button disabled={busy} className={primary}>{busy ? "Connecting…" : "Connect"}</button>
        </form>
        <ErrorNote text={error} />
      </Shell>
    );
  }

  if (step === 3) {
    const check = () =>
      run(async () => {
        const result = await api<{ domain: SetupDomain; dns: DnsReport | null }>("/api/setup/domain/verify", { method: "POST" });
        setDomainInfo(result.domain);
        setDns(result.dns);
      });
    return (
      <Shell step={3} title={`Add these DNS records for ${domain}`}>
        <p className="text-sm">
          In Cloudflare open <b>{domain} → DNS → Records</b> and add each record below with <b>Add record</b>. Set proxy to <b>DNS only</b> (grey cloud). Then press <b>Check</b>. It can take a few minutes.
        </p>
        {!domainInfo ? (
          <p className="text-sm text-neutral-500">Loading records…</p>
        ) : (
          <RecordsTable records={domainInfo.records} />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={busy || !domainInfo} className={primary} onClick={check}>{busy ? "Checking…" : "Check"}</button>
          {domainInfo && (
            <span className="text-sm">
              Resend: <Badge status={domainInfo.status} />
            </span>
          )}
        </div>
        {dns && (
          <ul className="space-y-1 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-950">
            <CheckRow label="SPF" check={dns.spf} />
            <CheckRow label="DMARC" check={dns.dmarc} />
            <CheckRow label="Receiving (MX)" check={dns.mx} />
            <li className="pt-1 text-xs text-neutral-500">MX and SPF warnings are normal until you turn on Email Routing in step 6.</li>
          </ul>
        )}
        <ErrorNote text={error} />
      </Shell>
    );
  }

  if (step === 4) {
    const finish = (replaceWebhooks: boolean) =>
      run(async () => {
        try {
          await api("/api/setup/sending", { body: { replaceWebhooks } });
          setReplace(null);
          await reload();
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && Array.isArray(err.body.existing)) {
            setReplace(err.body.existing as string[]);
            return;
          }
          throw err;
        }
      });
    return (
      <Shell step={4} title="Finish sending">
        <p className="text-sm">
          <Badge status="verified" /> Resend verified {domain}. Now QuadMail creates its webhook (so it learns about deliveries and bounces) and a key that can only send from {domain}.
        </p>
        {replace ? (
          <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <p>
              Your Resend account already has a webhook, and the free plan allows only one: <code className="break-all">{replace.join(", ")}</code>
            </p>
            <p>Replace it with QuadMail's? The other tool stops receiving delivery events from Resend.</p>
            <div className="flex gap-2">
              <button disabled={busy} className={primary} onClick={() => finish(true)}>Replace it</button>
              <button disabled={busy} className={secondary} onClick={() => setReplace(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button disabled={busy} className={primary} onClick={() => finish(false)}>{busy ? "Setting up…" : "Set up sending"}</button>
        )}
        <ErrorNote text={error} />
      </Shell>
    );
  }

  if (step === 5) {
    const workerName = window.location.hostname.split(".")[0];
    return (
      <Shell step={5} title="Receive mail">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            In Cloudflare open <b>{domain} → Email → Email Routing</b> and turn it on (Cloudflare adds the MX and SPF records).
          </li>
          <li>
            Open <b>Routing rules</b>, edit <b>Catch-all address</b>: action <b>Send to a Worker</b>, destination <b>{workerName}</b>. Save.
          </li>
          <li>Get a test address below and send any mail to it, for example from your phone.</li>
        </ol>
        {inbound.address ? (
          <div className="space-y-2 rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-950">
            <div className="flex flex-wrap items-center gap-2">
              Send a mail to <code className="font-semibold">{inbound.address}</code> <Copy value={inbound.address} />
            </div>
            {inbound.received ? <p className="font-medium text-green-700 dark:text-green-300">✓ It arrived. Receiving works.</p> : <p className="text-neutral-500">Waiting for it… (checks every 5 seconds)</p>}
          </div>
        ) : (
          <button
            disabled={busy}
            className={secondary}
            onClick={() => run(async () => setInbound({ address: (await api<{ address: string }>("/api/setup/inbound-test", { method: "POST" })).address, received: false }))}
          >
            Give me a test address
          </button>
        )}
        <div className="flex gap-2">
          <button className={primary} disabled={!inbound.received} onClick={() => setLater("test")}>Next</button>
          {!inbound.received && (
            <button className={secondary} onClick={() => setLater("test")}>
              Skip for now
            </button>
          )}
        </div>
        <ErrorNote text={error} />
      </Shell>
    );
  }

  if (step === 6) {
    return (
      <Shell step={6} title="Send a test mail">
        <p className="text-sm">Send a test to one of your personal addresses (for example Gmail) to check that it arrives in the inbox.</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/api/setup/send-test", { body: { to: testTo.trim() } });
              setTestSent(true);
            });
          }}
        >
          <input className={`${input} flex-1`} type="email" required placeholder="you@gmail.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button disabled={busy} className={secondary}>{busy ? "Sending…" : "Send test"}</button>
        </form>
        {testSent && (
          <p className="text-sm text-green-700 dark:text-green-300">
            ✓ Sent. Check that inbox (and its spam folder). In Gmail, <b>⋮ → Show original</b> should show SPF, DKIM and DMARC as PASS.
          </p>
        )}
        <div className="flex gap-2">
          <button className={primary} onClick={() => setLater("done")}>{testSent ? "Next" : "Skip"}</button>
        </div>
        <ErrorNote text={error} />
      </Shell>
    );
  }

  return (
    <Shell step={7} title="You're ready">
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>
          <b>Turn on two-factor login</b> in Settings. Your account is the admin.
        </li>
        <li>
          <b>Team</b> (sidebar): add the people who need an address.
        </li>
        <li>
          <b>Usage</b> (sidebar): the free plan sends {`up to 100 mails a day`}; QuadMail warns you at 80%.
        </li>
        {!inbound.received && <li>Receiving was not tested yet: set the catch-all in Email Routing (step 6) and send yourself a mail.</li>}
      </ul>
      <button disabled={busy} className={primary} onClick={() => run(async () => {
        await api("/api/setup/finish", { method: "POST" });
        window.location.hash = "#/inbox";
        window.location.reload();
      })}>
        Open my mailbox
      </button>
      <ErrorNote text={error} />
    </Shell>
  );
}

export function Wizard({ status, onAdminCreated }: { status: SetupStatus; onAdminCreated: () => void }) {
  const [current, setCurrent] = useState(status);
  const reload = useCallback(async () => setCurrent(await api<SetupStatus>("/api/setup/status")), []);
  if (current.state === "fresh") return <CreateAdmin codeConfigured={current.codeConfigured} onCreated={onAdminCreated} />;
  return <Configure status={current} reload={reload} />;
}
