// A small in-memory stand-in for the parts of the Resend API QuadMail uses, for the setup e2e test.
// Keys: "re_full" has full access, "re_restricted" can only send, anything else is invalid; keys created
// through POST /api-keys can send. A domain becomes "verified" on its first verify call.
import { createServer } from "node:http";

export function startMockResend(port) {
  const state = {
    domains: new Map(),
    webhooks: [{ id: "w-old", endpoint: "https://old-tool.example/hook", events: ["email.sent"], status: "enabled" }],
    keys: new Map([["re_full", "full_access"], ["re_restricted", "sending_access"]]),
    emails: [],
    createdKeys: [],
  };
  let seq = 0;
  const id = (p) => `${p}-${++seq}`;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (!req.headers["user-agent"]) return send(403, { name: "missing_user_agent", message: "User-Agent required" });
      const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const permission = state.keys.get(key);
      if (!permission) return send(401, { name: "validation_error", message: "API key is invalid" });
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, "http://mock");
      const path = url.pathname;
      const full = permission === "full_access";

      if (req.method === "POST" && path === "/emails") {
        state.emails.push({ key, body });
        return send(200, { id: id("email") });
      }
      if (!full) return send(401, { name: "restricted_api_key", message: "This API key is restricted to only send emails" });

      if (req.method === "GET" && path === "/domains") return send(200, { object: "list", has_more: false, data: [...state.domains.values()].map(({ id, name, status }) => ({ id, name, status })) });
      if (req.method === "POST" && path === "/domains") {
        const domain = {
          id: id("dom"),
          name: body.name,
          status: "not_started",
          region: "us-east-1",
          records: [
            { record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=MIGfMA0GCSq", ttl: "Auto", status: "not_started" },
            { record: "SPF", name: "send", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10, ttl: "Auto", status: "not_started" },
            { record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:amazonses.com ~all", ttl: "Auto", status: "not_started" },
          ],
        };
        state.domains.set(domain.id, domain);
        return send(200, domain);
      }
      const domainMatch = /^\/domains\/([^/]+)(\/verify)?$/.exec(path);
      if (domainMatch) {
        const domain = state.domains.get(domainMatch[1]);
        if (!domain) return send(404, { name: "not_found", message: "Domain not found" });
        if (req.method === "POST" && domainMatch[2]) {
          domain.status = "verified";
          for (const r of domain.records) r.status = "verified";
          return send(200, { object: "domain", id: domain.id });
        }
        if (req.method === "GET") return send(200, domain);
      }
      if (req.method === "GET" && path === "/webhooks") return send(200, { object: "list", has_more: false, data: state.webhooks });
      if (req.method === "POST" && path === "/webhooks") {
        if (state.webhooks.length >= 1) return send(403, { name: "validation_error", message: "Webhook endpoint limit reached" });
        const hook = { id: id("wh"), endpoint: body.endpoint, events: body.events, status: "enabled", secret: `whsec_${Buffer.from(`secret-${seq}-padding-bytes`).toString("base64")}` };
        state.webhooks.push(hook);
        return send(200, { object: "webhook", id: hook.id, signing_secret: hook.secret });
      }
      const hookMatch = /^\/webhooks\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && hookMatch) {
        state.webhooks = state.webhooks.filter((h) => h.id !== hookMatch[1]);
        return send(200, { object: "webhook", id: hookMatch[1], deleted: true });
      }
      if (req.method === "POST" && path === "/api-keys") {
        const token = `re_sending_${++seq}`;
        state.keys.set(token, body.permission);
        state.createdKeys.push({ token, ...body });
        return send(200, { id: id("key"), object: "api_key", token });
      }
      send(404, { name: "not_found", message: `${req.method} ${path}` });
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ state, close: () => server.close() })));
}
