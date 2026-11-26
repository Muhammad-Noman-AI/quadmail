// DNS checks for the setup wizard, through Cloudflare's DNS-over-HTTPS JSON API.
// https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
import type { DnsCheck, DnsReport } from "../../shared/types";

const DOH = "https://cloudflare-dns.com/dns-query";

/** TXT data comes quoted and may be split into several strings: "v=spf1 " "include:..." */
function unquoteTxt(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("") : data;
}

export interface DnsAnswers {
  rootTxt: string[];
  dmarcTxt: string[];
  mx: string[];
}

/** Judge the answers. Pure, for tests. */
export function evaluateDns(domain: string, answers: DnsAnswers): DnsReport {
  const spf = answers.rootTxt.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  const dmarc = answers.dmarcTxt.filter((t) => /^v=DMARC1(\s*;|$)/i.test(t.trim()));
  const mx = answers.mx.map((m) => m.trim().toLowerCase().replace(/\.$/, ""));

  const spfCheck: DnsCheck =
    spf.length === 0
      ? { status: "warn", message: "No SPF record yet. Cloudflare adds one when you turn on Email Routing." }
      : spf.length > 1
        ? { status: "fail", message: `There are ${spf.length} SPF records on ${domain}. Merge them into one: receivers ignore SPF when there are several.` }
        : /include:_spf\.mx\.cloudflare\.net/i.test(spf[0]!)
          ? { status: "ok", message: "One SPF record, including Cloudflare Email Routing." }
          : { status: "warn", message: "The SPF record does not include include:_spf.mx.cloudflare.net. Add it once Email Routing is on." };

  const dmarcCheck: DnsCheck =
    dmarc.length === 0
      ? { status: "warn", message: `No DMARC record. Add a TXT record named _dmarc with: v=DMARC1; p=none; rua=mailto:dmarc@${domain}` }
      : dmarc.length > 1
        ? { status: "fail", message: `There are ${dmarc.length} DMARC records. Keep exactly one; with two, Gmail treats DMARC as failed.` }
        : { status: "ok", message: "One DMARC record." };

  const mxCheck: DnsCheck =
    mx.length === 0
      ? { status: "warn", message: "No MX records yet. Turn on Email Routing in Cloudflare to receive mail." }
      : mx.every((m) => m.endsWith(".mx.cloudflare.net"))
        ? { status: "ok", message: "Mail for the domain goes to Cloudflare Email Routing." }
        : { status: "fail", message: `Some MX records point elsewhere (${mx.filter((m) => !m.endsWith(".mx.cloudflare.net")).join(", ")}). Remove them so all mail reaches QuadMail.` };

  return { spf: spfCheck, dmarc: dmarcCheck, mx: mxCheck };
}

async function query(name: string, type: "TXT" | "MX", fetcher: typeof fetch): Promise<string[]> {
  const response = await fetcher(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" } });
  if (!response.ok) throw new Error(`DNS lookup failed (${response.status})`);
  const data = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
  const wanted = type === "TXT" ? 16 : 15;
  return (data.Answer ?? [])
    .filter((a) => a.type === wanted)
    .map((a) => (type === "TXT" ? unquoteTxt(a.data) : a.data.split(/\s+/).pop() ?? ""));
}

export async function checkDomainDns(domain: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<DnsReport> {
  const [rootTxt, dmarcTxt, mx] = await Promise.all([query(domain, "TXT", fetcher), query(`_dmarc.${domain}`, "TXT", fetcher), query(domain, "MX", fetcher)]);
  return evaluateDns(domain, { rootTxt, dmarcTxt, mx });
}

export { unquoteTxt };
