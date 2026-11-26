// Resend account administration for the setup wizard: domains, webhook, sending key.
// Needs a full-access key, which the wizard keeps only until the sending-only key exists.
// Docs: https://resend.com/docs/api-reference (domains, webhooks, api-keys)

export class ResendAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ResendRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  ttl?: string;
  status: string;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  region?: string;
  records: ResendRecord[];
}

export interface ResendWebhook {
  id: string;
  endpoint: string;
  events: string[];
  status?: string;
}

/** Events QuadMail handles (src/worker/send/webhook.ts). */
export const WEBHOOK_EVENTS = ["email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed", "email.suppressed"];

function friendly(status: number, name: string, message: string): string {
  if (status === 401 && name === "restricted_api_key") return "This key can only send. Create a key with Full access for the setup (QuadMail replaces it with a sending-only key).";
  if (status === 401 || name === "missing_api_key" || name === "invalid_api_key") return "Resend did not accept this key. Copy it again from Resend → API Keys.";
  if (status === 429) return "Resend is limiting requests. Wait a few seconds and try again.";
  return message ? `Resend: ${message}` : `Resend returned an error (HTTP ${status}).`;
}

export class ResendAdmin {
  constructor(
    private readonly key: string,
    private readonly base = "https://api.resend.com",
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          // Resend rejects requests without a User-Agent (403).
          "user-agent": "QuadMail-Setup",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ResendAdminError(0, "Could not reach Resend. Try again.");
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const name = typeof data.name === "string" ? data.name : "";
      const message = typeof data.message === "string" ? data.message.slice(0, 300) : "";
      throw new ResendAdminError(response.status, friendly(response.status, name, message));
    }
    return data as T;
  }

  async findDomain(name: string): Promise<ResendDomain | null> {
    const list = await this.call<{ data?: Array<{ id: string; name: string }> }>("GET", "/domains");
    const match = (list.data ?? []).find((d) => d.name.toLowerCase() === name.toLowerCase());
    return match ? this.getDomain(match.id) : null;
  }

  async createDomain(name: string): Promise<ResendDomain> {
    const created = await this.call<ResendDomain>("POST", "/domains", { name });
    return { ...created, records: created.records ?? [] };
  }

  async getDomain(id: string): Promise<ResendDomain> {
    const domain = await this.call<ResendDomain>("GET", `/domains/${encodeURIComponent(id)}`);
    return { ...domain, records: domain.records ?? [] };
  }

  /** Starts Resend's asynchronous check; read the result with getDomain. */
  async verifyDomain(id: string): Promise<void> {
    await this.call("POST", `/domains/${encodeURIComponent(id)}/verify`);
  }

  async listWebhooks(): Promise<ResendWebhook[]> {
    return (await this.call<{ data?: ResendWebhook[] }>("GET", "/webhooks?limit=100")).data ?? [];
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.call("DELETE", `/webhooks/${encodeURIComponent(id)}`);
  }

  /** The signing secret is only returned here, at creation. */
  async createWebhook(endpoint: string): Promise<{ id: string; signingSecret: string }> {
    const created = await this.call<{ id: string; signing_secret: string }>("POST", "/webhooks", { endpoint, events: WEBHOOK_EVENTS });
    if (!created.signing_secret) throw new ResendAdminError(502, "Resend did not return the webhook signing secret.");
    return { id: created.id, signingSecret: created.signing_secret };
  }

  /** A key that can only send; restricted to one domain when domainId is given. The token is only returned here. */
  async createSendingKey(name: string, domainId: string | null): Promise<string> {
    const created = await this.call<{ token?: string }>("POST", "/api-keys", {
      name: name.slice(0, 50),
      permission: "sending_access",
      ...(domainId ? { domain_id: domainId } : {}),
    });
    if (!created.token?.startsWith("re_")) throw new ResendAdminError(502, "Resend did not return the new key.");
    return created.token;
  }
}
