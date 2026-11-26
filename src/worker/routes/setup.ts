// Self-setup wizard API. Only usable while the installation is "fresh" (no users) or "in_progress"
// (the first admin exists and the wizard is not finished). Installations set up by hand count as
// "complete", so none of this is reachable there.
import { z } from "zod";
import type { SetupDomain, SetupStatus } from "../../shared/types";
import { ulid } from "../../shared/ulid";
import { sha256Hex, timingSafeEqual, toHex } from "../auth/crypto";
import { hashPasswordKey } from "../auth/password";
import { isLimited, recordFailure } from "../auth/rate-limit";
import { audit, auditStatement, readJson, secured } from "../auth/respond";
import { assertSameOrigin, clientIp, createSession, findSession, requireAdmin, SESSION_TTL_MS, sessionCookie, type Session } from "../auth/session";
import { appConfig, clearConfigCache, saveConfig, storedConfig, type ResolvedConfig } from "../config";
import { HttpError, json } from "../http";
import type { Route } from "../router";
import { sendSystemEmail } from "../send/system";
import { checkDomainDns } from "../setup/dns";
import { ResendAdmin, ResendAdminError, type ResendDomain } from "../setup/resend-admin";

/** The full-access key is kept between steps 3 and 5 at most this long. */
const SETUP_KEY_TTL_MS = 2 * 60 * 60 * 1000;
const DOMAIN = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

const adminBody = z.object({
  code: z.string().min(1).max(200),
  orgName: z.string().trim().min(1).max(100),
  domain: z.string().trim().toLowerCase().regex(DOMAIN),
  email: z.email().max(254),
  displayName: z.string().trim().max(100).nullable().optional(),
  passwordKey: z.string().regex(/^[0-9a-f]{64}$/),
});
const resendBody = z.object({ apiKey: z.string().trim().startsWith("re_").max(200) });
const sendingBody = z.object({ replaceWebhooks: z.boolean().optional() });
const testBody = z.object({ to: z.email().max(254) });

function setupCode(env: Env): string | null {
  const code = (env as unknown as { SETUP_CODE?: string }).SETUP_CODE;
  return code && code.length >= 8 ? code : null;
}

/** Compare hashes so neither the length nor the content of the code leaks through timing. */
async function codeMatches(given: string, expected: string): Promise<boolean> {
  return timingSafeEqual(await sha256Hex(given), await sha256Hex(expected));
}

/** Steps after the admin exists: that admin's session, while the wizard is still running. */
async function requireSetupAdmin(request: Request, env: Env): Promise<{ session: Session; cfg: ResolvedConfig }> {
  const session = await requireAdmin(request, env);
  clearConfigCache();
  const cfg = await appConfig(env);
  if (cfg.setupState !== "in_progress") throw new HttpError(409, "Setup is already finished. Use Settings to change domains and sending.");
  return { session, cfg };
}

function toSetupDomain(domain: ResendDomain): SetupDomain {
  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    records: domain.records.map((r) => ({ record: r.record, name: r.name, type: r.type, value: r.value, ...(r.priority !== undefined ? { priority: r.priority } : {}), status: r.status })),
  };
}

/** The full-access key from step 3, while it is still allowed to be held. */
async function setupAdmin(env: Env, cfg: ResolvedConfig): Promise<{ admin: ResendAdmin; domainId: string }> {
  const stored = await storedConfig(env);
  const at = Number(stored.resend_setup_key_at);
  if (!stored.resend_setup_key || !Number.isFinite(at) || Date.now() - at > SETUP_KEY_TTL_MS) {
    await saveConfig(env, { resend_setup_key: null, resend_setup_key_at: null });
    throw new HttpError(410, "For your security the Resend key is only kept for 2 hours. Paste it again in the Resend step.");
  }
  if (!stored.resend_domain_id) throw new HttpError(400, "Connect Resend first.");
  return { admin: new ResendAdmin(stored.resend_setup_key, cfg.resendApiBase), domainId: stored.resend_domain_id };
}

function resendError(err: unknown): never {
  if (err instanceof ResendAdminError) throw new HttpError(err.status >= 400 && err.status < 500 ? 400 : 502, err.message);
  throw err;
}

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/setup/status",
    handler: async ({ request, env }) => {
      clearConfigCache();
      const cfg = await appConfig(env);
      const base = { state: cfg.setupState, codeConfigured: setupCode(env) !== null };
      // Details only for the admin running the wizard; anyone may learn whether setup is needed.
      if (cfg.setupState !== "in_progress") return json(base);
      const viewer = await findSession(request, env);
      if (viewer?.role !== "admin") return json(base);
      const stored = await storedConfig(env);
      const at = Number(stored.resend_setup_key_at);
      const status: SetupStatus = {
        ...base,
        orgName: cfg.orgName,
        domain: cfg.allowedDomains[0] ?? null,
        resendConnected: !!stored.resend_domain_id,
        setupKeyHeld: !!stored.resend_setup_key && Number.isFinite(at) && Date.now() - at <= SETUP_KEY_TTL_MS,
        sendingReady: !!cfg.resendApiKey && !!cfg.webhookSecret,
        inboundTestAddress: stored.inbound_test_address ?? null,
        inboundVerified: stored.inbound_verified === "1",
      };
      return json(status);
    },
  },
  {
    // Step 1 + 2: prove ownership with the setup code, create the organisation and its first admin.
    method: "POST",
    path: "/api/setup/admin",
    handler: async ({ request, env }) => {
      assertSameOrigin(request, env);
      clearConfigCache();
      if ((await appConfig(env)).setupState !== "fresh") throw new HttpError(409, "This QuadMail is already set up. Sign in instead.");
      const expected = setupCode(env);
      if (!expected) {
        throw new HttpError(403, "This installation has no setup code. In Cloudflare, add a SETUP_CODE secret to the Worker (at least 8 characters), then reload.");
      }
      const keys = [`setup:${clientIp(request)}`];
      if (await isLimited(env.DB, keys)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
      const body = await readJson(request, (v) => adminBody.parse(v));
      if (!(await codeMatches(body.code, expected))) {
        await recordFailure(env.DB, keys);
        throw new HttpError(401, "That setup code is not correct.");
      }
      const email = body.email.trim().toLowerCase();
      if (!email.endsWith(`@${body.domain}`)) throw new HttpError(400, `The admin email must be an address on ${body.domain}.`);

      const userId = ulid();
      const now = Date.now();
      // The conditional insert makes two simultaneous claims safe: only one finds no users.
      const [insert] = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (id, email, password_hash, created_at, role, display_name)
           SELECT ?, ?, ?, ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
        ).bind(userId, email, await hashPasswordKey(body.passwordKey), now, body.displayName || null),
      ]);
      if (!insert?.meta.changes) throw new HttpError(409, "This QuadMail was just set up by someone else. Sign in instead.");
      await env.DB.batch([
        env.DB.prepare("INSERT INTO identities (id, user_id, address, display_name, is_default) VALUES (?, ?, ?, ?, 1)").bind(ulid(), userId, email, body.displayName || null),
        auditStatement(env.DB, email, "setup.admin_created", { domain: body.domain }),
      ]);
      await saveConfig(env, { org_name: body.orgName, sending_domains: body.domain, app_url: new URL(request.url).origin, setup_state: "in_progress" });
      const token = await createSession(env, request, userId);
      return json({ ok: true }, { status: 201, headers: { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000) } });
    },
  },
  {
    // Step 3: a full-access key; find or add the domain and show its DNS records.
    method: "POST",
    path: "/api/setup/resend",
    handler: async ({ request, env }) => {
      const { session, cfg } = await requireSetupAdmin(request, env);
      const { apiKey } = await readJson(request, (v) => resendBody.parse(v));
      const name = cfg.allowedDomains[0];
      if (!name) throw new HttpError(400, "No domain is configured.");
      const admin = new ResendAdmin(apiKey, cfg.resendApiBase);
      let domain: ResendDomain;
      try {
        domain = (await admin.findDomain(name)) ?? (await admin.createDomain(name));
      } catch (err) {
        resendError(err);
      }
      await saveConfig(env, { resend_domain_id: domain.id, resend_setup_key: apiKey, resend_setup_key_at: String(Date.now()) });
      await audit(env.DB, session.email, "setup.resend_connected", { domain: name });
      return json(toSetupDomain(domain));
    },
  },
  {
    method: "GET",
    path: "/api/setup/domain",
    handler: async ({ request, env }) => {
      const { cfg } = await requireSetupAdmin(request, env);
      const { admin, domainId } = await setupAdmin(env, cfg);
      try {
        return json(toSetupDomain(await admin.getDomain(domainId)));
      } catch (err) {
        resendError(err);
      }
    },
  },
  {
    // Step 4: ask Resend to check the records, and check SPF / DMARC / MX ourselves.
    method: "POST",
    path: "/api/setup/domain/verify",
    handler: async ({ request, env }) => {
      const { cfg } = await requireSetupAdmin(request, env);
      const { admin, domainId } = await setupAdmin(env, cfg);
      let domain: ResendDomain;
      try {
        await admin.verifyDomain(domainId);
        domain = await admin.getDomain(domainId);
      } catch (err) {
        resendError(err);
      }
      const dns = await checkDomainDns(domain.name).catch(() => null);
      return json({ domain: toSetupDomain(domain), dns });
    },
  },
  {
    method: "GET",
    path: "/api/setup/dns",
    handler: async ({ request, env }) => {
      const { cfg } = await requireSetupAdmin(request, env);
      const name = cfg.allowedDomains[0];
      if (!name) throw new HttpError(400, "No domain is configured.");
      try {
        return json(await checkDomainDns(name));
      } catch {
        throw new HttpError(502, "The DNS lookup failed. Try again in a moment.");
      }
    },
  },
  {
    // Step 5: webhook + sending-only key; the full-access key is then forgotten.
    method: "POST",
    path: "/api/setup/sending",
    handler: async ({ request, env }) => {
      const { session, cfg } = await requireSetupAdmin(request, env);
      const body = await readJson(request, (v) => sendingBody.parse(v));
      const { admin, domainId } = await setupAdmin(env, cfg);
      const endpoint = `${new URL(request.url).origin}/api/webhooks/resend`;
      try {
        const domain = await admin.getDomain(domainId);
        if (domain.status !== "verified") throw new HttpError(400, "Resend has not verified the domain yet. Add the DNS records and press Check first.");
        const hooks = await admin.listWebhooks();
        const others = hooks.filter((h) => h.endpoint !== endpoint);
        if (others.length && !body.replaceWebhooks) {
          // Resend Free allows one webhook endpoint: the user decides whether to replace theirs.
          return json({ needsConfirmation: true, existing: others.map((h) => h.endpoint) }, { status: 409 });
        }
        // An existing webhook for this endpoint is recreated: its signing secret cannot be read back.
        for (const hook of hooks) await admin.deleteWebhook(hook.id);
        const webhook = await admin.createWebhook(endpoint);
        const sendingKey = await admin.createSendingKey(`QuadMail ${domain.name}`, domainId);
        await saveConfig(env, { resend_api_key: sendingKey, resend_webhook_secret: webhook.signingSecret, resend_setup_key: null, resend_setup_key_at: null });
        await audit(env.DB, session.email, "setup.sending_ready", { domain: domain.name, replacedWebhooks: others.length });
        return json({ ok: true });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        resendError(err);
      }
    },
  },
  {
    // Step 6: an address to send a test mail to; mail to unknown addresses lands with the admin.
    method: "POST",
    path: "/api/setup/inbound-test",
    handler: async ({ request, env }) => {
      const { cfg } = await requireSetupAdmin(request, env);
      const name = cfg.allowedDomains[0];
      if (!name) throw new HttpError(400, "No domain is configured.");
      const address = `setup-${toHex(crypto.getRandomValues(new Uint8Array(3)))}@${name}`;
      await saveConfig(env, { inbound_test_address: address, inbound_verified: null });
      return json({ address });
    },
  },
  {
    method: "GET",
    path: "/api/setup/inbound-test",
    handler: async ({ request, env }) => {
      const { session } = await requireSetupAdmin(request, env);
      const stored = await storedConfig(env);
      const address = stored.inbound_test_address;
      if (!address) return json({ address: null, received: false });
      const hit = await env.DB.prepare("SELECT 1 AS one FROM messages WHERE user_id = ? AND envelope_to = ? LIMIT 1").bind(session.userId, address).first();
      if (hit && stored.inbound_verified !== "1") await saveConfig(env, { inbound_verified: "1" });
      return json({ address, received: hit !== null });
    },
  },
  {
    // Step 7: a real mail through the new sending key.
    method: "POST",
    path: "/api/setup/send-test",
    handler: async ({ request, env }) => {
      const { session, cfg } = await requireSetupAdmin(request, env);
      const { to } = await readJson(request, (v) => testBody.parse(v));
      const org = cfg.orgName ?? "QuadMail";
      await sendSystemEmail(env.DB, cfg, { address: session.email, name: org }, to, {
        subject: `QuadMail test from ${session.email}`,
        text: `This is a test from your new QuadMail (${org}).\n\nIf you can read this, sending works.`,
        html: `<p>This is a test from your new QuadMail (${org.replace(/[&<>"']/g, "")}).</p><p>If you can read this, sending works.</p>`,
      });
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    path: "/api/setup/finish",
    handler: async ({ request, env }) => {
      const { session } = await requireSetupAdmin(request, env);
      await saveConfig(env, { setup_state: "complete", resend_setup_key: null, resend_setup_key_at: null, inbound_test_address: null });
      await audit(env.DB, session.email, "setup.finished");
      return json({ ok: true });
    },
  },
];

export const setupRoutes: Route[] = routes.map(secured);
