// Settings → Domains & sending (admin). Same Resend automation as the setup wizard: a full-access key
// is pasted for the change, held at most 2 hours, and replaced by a sending-only key.
import { z } from "zod";
import type { SendingSettingsInfo } from "../../shared/types";
import { parseConfig } from "../../shared/env";
import { audit, readJson, secured } from "../auth/respond";
import { requireAdmin } from "../auth/session";
import { appConfig, clearConfigCache, saveConfig, storedConfig, type ResolvedConfig } from "../config";
import { HttpError, json } from "../http";
import type { Route } from "../router";
import { checkDomainDns } from "../setup/dns";
import { ResendAdmin, type ResendDomain } from "../setup/resend-admin";
import { DOMAIN, resendError, SETUP_KEY_TTL_MS, toSetupDomain } from "./setup";

const keyField = z.string().trim().startsWith("re_").max(200);
const addBody = z.object({ domain: z.string().trim().toLowerCase().regex(DOMAIN), apiKey: keyField });
const limitBody = z.object({ dailyLimit: z.number().int().min(1).max(100) });
const keyBody = z.object({ apiKey: keyField });

function fromEnv(env: Env) {
  const e = parseConfig(env as unknown as Record<string, unknown>);
  return { domains: !!e.ALLOWED_SENDING_DOMAINS, limit: e.DAILY_SEND_LIMIT !== undefined, key: !!e.RESEND_API_KEY };
}

async function adminAndConfig(request: Request, env: Env): Promise<{ email: string; cfg: ResolvedConfig }> {
  const session = await requireAdmin(request, env);
  clearConfigCache();
  return { email: session.email, cfg: await appConfig(env) };
}

/** New sending-only key covering every configured domain (restricted when there is just one). */
async function newSendingKey(admin: ResendAdmin, domains: string[]): Promise<string> {
  let only: ResendDomain | null = null;
  if (domains.length === 1) only = await admin.findDomain(domains[0]!);
  return admin.createSendingKey(domains.length === 1 ? `QuadMail ${domains[0]}` : "QuadMail (all domains)", only?.id ?? null);
}

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/admin/sending",
    handler: async ({ request, env }) => {
      const { cfg } = await adminAndConfig(request, env);
      const env_ = fromEnv(env);
      const info: SendingSettingsInfo = {
        domains: cfg.allowedDomains,
        domainsFromEnv: env_.domains,
        dailyLimit: cfg.dailyLimit,
        limitFromEnv: env_.limit,
        keyFromEnv: env_.key,
        providerReady: cfg.provider === "resend" && !!cfg.resendApiKey,
        pendingDomain: (await storedConfig(env)).pending_domain ?? null,
      };
      return json(info);
    },
  },
  {
    method: "PATCH",
    path: "/api/admin/sending",
    handler: async ({ request, env }) => {
      const { email } = await adminAndConfig(request, env);
      if (fromEnv(env).limit) throw new HttpError(409, "The daily limit is set by the DAILY_SEND_LIMIT variable on this installation.");
      const { dailyLimit } = await readJson(request, (v) => limitBody.parse(v));
      await saveConfig(env, { daily_limit: String(dailyLimit) });
      await audit(env.DB, email, "settings.daily_limit", { dailyLimit });
      return json({ ok: true });
    },
  },
  {
    // Start adding a domain: find or add it at Resend and return the DNS records.
    method: "POST",
    path: "/api/admin/domains",
    handler: async ({ request, env }) => {
      const { email, cfg } = await adminAndConfig(request, env);
      if (fromEnv(env).domains) throw new HttpError(409, "Domains are set by the ALLOWED_SENDING_DOMAINS variable on this installation.");
      const body = await readJson(request, (v) => addBody.parse(v));
      if (cfg.allowedDomains.includes(body.domain)) throw new HttpError(409, `${body.domain} is already a sending domain.`);
      const admin = new ResendAdmin(body.apiKey, cfg.resendApiBase);
      let domain: ResendDomain;
      try {
        domain = (await admin.findDomain(body.domain)) ?? (await admin.createDomain(body.domain));
      } catch (err) {
        resendError(err);
      }
      await saveConfig(env, { pending_domain: body.domain, pending_domain_id: domain.id, resend_setup_key: body.apiKey, resend_setup_key_at: String(Date.now()) });
      await audit(env.DB, email, "settings.domain_started", { domain: body.domain });
      return json(toSetupDomain(domain));
    },
  },
  {
    // Check the pending domain; once Resend has verified it, it becomes a sending domain.
    method: "POST",
    path: "/api/admin/domains/verify",
    handler: async ({ request, env }) => {
      const { email, cfg } = await adminAndConfig(request, env);
      const stored = await storedConfig(env);
      const at = Number(stored.resend_setup_key_at);
      if (!stored.pending_domain || !stored.pending_domain_id) throw new HttpError(400, "No domain is being added.");
      if (!stored.resend_setup_key || !Number.isFinite(at) || Date.now() - at > SETUP_KEY_TTL_MS) {
        throw new HttpError(410, "For your security the Resend key is only kept for 2 hours. Start adding the domain again.");
      }
      const admin = new ResendAdmin(stored.resend_setup_key, cfg.resendApiBase);
      try {
        await admin.verifyDomain(stored.pending_domain_id);
        const domain = await admin.getDomain(stored.pending_domain_id);
        const dns = await checkDomainDns(domain.name).catch(() => null);
        if (domain.status !== "verified") return json({ added: false, domain: toSetupDomain(domain), dns });
        const domains = [...cfg.allowedDomains, stored.pending_domain];
        // The old key may be restricted to the first domain: the new one must cover all of them.
        const key = fromEnv(env).key ? null : await newSendingKey(admin, domains);
        await saveConfig(env, {
          sending_domains: domains.join(","),
          ...(key ? { resend_api_key: key } : {}),
          pending_domain: null,
          pending_domain_id: null,
          resend_setup_key: null,
          resend_setup_key_at: null,
        });
        await audit(env.DB, email, "settings.domain_added", { domain: stored.pending_domain });
        return json({ added: true, domain: toSetupDomain(domain), dns });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        resendError(err);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/domains/pending",
    handler: async ({ request, env }) => {
      await adminAndConfig(request, env);
      await saveConfig(env, { pending_domain: null, pending_domain_id: null, resend_setup_key: null, resend_setup_key_at: null });
      return json({ ok: true });
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/domains/:domain",
    handler: async ({ request, env, params }) => {
      const { email, cfg } = await adminAndConfig(request, env);
      if (fromEnv(env).domains) throw new HttpError(409, "Domains are set by the ALLOWED_SENDING_DOMAINS variable on this installation.");
      const domain = (params.domain ?? "").toLowerCase();
      if (!cfg.allowedDomains.includes(domain)) throw new HttpError(404, "Not a sending domain.");
      if (cfg.allowedDomains.length === 1) throw new HttpError(400, "QuadMail needs at least one domain.");
      // Sending from it stops at once (the send rules check this list); the Resend domain is left alone.
      await saveConfig(env, { sending_domains: cfg.allowedDomains.filter((d) => d !== domain).join(",") });
      await audit(env.DB, email, "settings.domain_removed", { domain });
      return json({ ok: true });
    },
  },
  {
    // Replace the stored sending key (for example after revoking it in Resend).
    method: "POST",
    path: "/api/admin/resend-key",
    handler: async ({ request, env }) => {
      const { email, cfg } = await adminAndConfig(request, env);
      if (fromEnv(env).key) throw new HttpError(409, "The Resend key is set by the RESEND_API_KEY secret on this installation.");
      const { apiKey } = await readJson(request, (v) => keyBody.parse(v));
      try {
        const key = await newSendingKey(new ResendAdmin(apiKey, cfg.resendApiBase), cfg.allowedDomains);
        await saveConfig(env, { resend_api_key: key });
      } catch (err) {
        resendError(err);
      }
      await audit(env.DB, email, "settings.resend_key_replaced");
      return json({ ok: true });
    },
  },
];

export const domainRoutes: Route[] = routes.map(secured);
