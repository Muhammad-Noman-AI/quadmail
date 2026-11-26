import { describe, expect, it } from "vitest";
import { evaluateDns, unquoteTxt } from "./dns";
import { ResendAdmin, ResendAdminError, WEBHOOK_EVENTS } from "./resend-admin";

describe("evaluateDns", () => {
  const good = { rootTxt: ["v=spf1 include:_spf.mx.cloudflare.net ~all", "google-site-verification=x"], dmarcTxt: ["v=DMARC1; p=none"], mx: ["route1.mx.cloudflare.net.", "route2.mx.cloudflare.net"] };

  it("passes a correct setup", () => {
    const report = evaluateDns("acme.com", good);
    expect([report.spf.status, report.dmarc.status, report.mx.status]).toEqual(["ok", "ok", "ok"]);
  });

  it("fails two SPF or two DMARC records, and foreign MX", () => {
    const report = evaluateDns("acme.com", {
      rootTxt: ["v=spf1 include:_spf.mx.cloudflare.net ~all", "v=spf1 include:mailgun.org ~all"],
      dmarcTxt: ["v=DMARC1; p=none; rua=mailto:a@x", "v=DMARC1; p=none"],
      mx: ["route1.mx.cloudflare.net", "aspmx.l.google.com"],
    });
    expect(report.spf.status).toBe("fail");
    expect(report.dmarc.status).toBe("fail");
    expect(report.mx.status).toBe("fail");
    expect(report.mx.message).toContain("aspmx.l.google.com");
  });

  it("warns, with the fix, when records are missing", () => {
    const report = evaluateDns("acme.com", { rootTxt: [], dmarcTxt: [], mx: [] });
    expect(report.spf.status).toBe("warn");
    expect(report.dmarc.message).toContain("v=DMARC1; p=none; rua=mailto:dmarc@acme.com");
    expect(report.mx.status).toBe("warn");
  });

  it("joins split TXT strings", () => {
    expect(unquoteTxt('"v=spf1 include:_spf.mx." "cloudflare.net ~all"')).toBe("v=spf1 include:_spf.mx.cloudflare.net ~all");
  });
});

function fakeResend(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
  const fetcher = (async (input: string, init: RequestInit) => {
    const path = input.replace("https://mock", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body, headers: init.headers as Record<string, string> });
    const handler = routes[`${init.method} ${path}`];
    const [status, data] = handler ? handler(body) : [404, { name: "not_found", message: "Not found" }];
    return new Response(JSON.stringify(data), { status });
  }) as unknown as typeof fetch;
  return { calls, admin: new ResendAdmin("re_full", "https://mock", fetcher) };
}

describe("ResendAdmin", () => {
  const domain = { id: "d1", name: "acme.com", status: "not_started", records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=MIG", status: "not_started" }] };

  it("finds an existing domain by name, case-insensitively, and sends a User-Agent", async () => {
    const { admin, calls } = fakeResend({ "GET /domains": () => [200, { data: [{ id: "d1", name: "ACME.com" }] }], "GET /domains/d1": () => [200, domain] });
    expect((await admin.findDomain("acme.com"))?.records[0]?.record).toBe("DKIM");
    expect(calls[0]?.headers["user-agent"]).toBe("QuadMail-Setup");
    expect(calls[0]?.headers.authorization).toBe("Bearer re_full");
  });

  it("creates the webhook with QuadMail's events and returns the signing secret", async () => {
    const { admin, calls } = fakeResend({ "POST /webhooks": () => [200, { object: "webhook", id: "w1", signing_secret: "whsec_abc" }] });
    expect(await admin.createWebhook("https://q.example/api/webhooks/resend")).toEqual({ id: "w1", signingSecret: "whsec_abc" });
    expect(calls[0]?.body).toEqual({ endpoint: "https://q.example/api/webhooks/resend", events: WEBHOOK_EVENTS });
  });

  it("creates a sending-only key for the domain", async () => {
    const { admin, calls } = fakeResend({ "POST /api-keys": () => [200, { id: "k1", object: "api_key", token: "re_send" }] });
    expect(await admin.createSendingKey("QuadMail acme.com", "d1")).toBe("re_send");
    expect(calls[0]?.body).toEqual({ name: "QuadMail acme.com", permission: "sending_access", domain_id: "d1" });
  });

  it("explains a sending-only key used where full access is needed", async () => {
    const { admin } = fakeResend({ "GET /domains": () => [401, { name: "restricted_api_key", message: "restricted" }] });
    const error = await admin.findDomain("acme.com").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResendAdminError);
    expect((error as Error).message).toContain("Full access");
  });
});
