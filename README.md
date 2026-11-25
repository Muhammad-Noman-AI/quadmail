# QuadMail

Self-owned email for `quadgentics.com`, running entirely on Cloudflare's free tier.

- **Receiving:** Cloudflare Email Routing (catch-all) → this Worker's `email()` handler → raw mail in R2, metadata in D1.
- **Webmail:** React single-page app served as Worker static assets; API at `/api/*` in the same Worker.
- **Parsing:** done in the browser with `postal-mime`, so the Worker stays inside the 10 ms free CPU limit.
- **Sending:** Resend API, behind a swappable provider interface.

See [docs/PLAN.md](docs/PLAN.md) for verified limits and phases, and `docs/SETUP.md` (Phase 7) for the human checklist.

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in values
pnpm cf-typegen                  # generate Worker types from wrangler.jsonc
pnpm dev                         # http://localhost:5173
pnpm check                       # typecheck + lint + tests
```

## Status

Phases 1–5 done: scaffold, D1 + R2, inbound pipeline, auth + read UI, sending. Next: first deploy, then Phase 6 (polish and operations).

## Sending (Resend)

Production needs two Worker secrets (never commit them):

```bash
pnpm exec wrangler secret put RESEND_API_KEY          # Resend → API Keys, "Sending access" for quadgentics.com
pnpm exec wrangler secret put RESEND_WEBHOOK_SECRET   # Resend → Webhooks → signing secret (whsec_…)
```

Webhook endpoint: `https://<app host>/api/webhooks/resend`, events `email.sent`, `email.delivered`, `email.bounced`,
`email.complained`, `email.failed`, `email.suppressed`. Permanent bounces and complaints add the recipient to
Settings → Suppressed addresses.

Rules enforced on every send: From must be one of your identities on `ALLOWED_SENDING_DOMAINS`; at most 20
recipients; at most `DAILY_SEND_LIMIT` recipients per UTC day (each To, Cc and Bcc address counts); attachments up to
10 MB per message. Attachments are Base64-encoded once at upload time, so the send request only streams bytes
from R2 and stays inside the 10 ms CPU limit.

## Database

```bash
pnpm db:migrate:local    # apply migrations to the local Miniflare D1
pnpm db:migrate:remote   # apply migrations to Cloudflare D1
pnpm smoke:local         # R2 put/get + D1 insert/FTS/delete against local state
pnpm smoke:remote        # same, against the real bucket and database
```
