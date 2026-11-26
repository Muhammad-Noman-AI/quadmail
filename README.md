# QuadMail

Self-owned email for `quadgentics.com`, running entirely on Cloudflare's free tier.

- **Receiving:** Cloudflare Email Routing (catch-all) → this Worker's `email()` handler → raw mail in R2, metadata in D1.
- **Webmail:** React single-page app served as Worker static assets; API at `/api/*` in the same Worker.
- **Parsing:** done in the browser with `postal-mime`, so the Worker stays inside the 10 ms free CPU limit.
- **Sending:** Resend API, behind a swappable provider interface.

See [docs/PLAN.md](docs/PLAN.md) for verified limits and phases, [docs/SETUP.md](docs/SETUP.md) to set up an installation from scratch, and [docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Get your own QuadMail

QuadMail runs on **your own** Cloudflare account (free plan) with a free Resend account for sending. You need a
domain on Cloudflare and a GitHub account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Muhammad-Noman-AI/quadmail)

1. Click **Deploy to Cloudflare** above. Cloudflare copies the code
   to your GitHub, creates the Worker, D1 and R2, runs the migrations and deploys. Choose a **setup code** in the form.
2. Open your new QuadMail address. The setup wizard asks for the setup code, then walks you through your domain,
   Resend, DNS records, receiving and a test mail.
3. Updates: in your GitHub copy, **Actions → Update QuadMail** runs every Monday (or on demand) and installs the
   latest release.

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in values
pnpm cf-typegen                  # generate Worker types from wrangler.jsonc
pnpm dev                         # http://localhost:5173 — a fresh installation (setup wizard)
pnpm dev:quadgentics             # the same, with the Quadgentics settings and local data
pnpm check                       # typecheck + lint + tests
```

## Status

Phases 1–5 done and deployed: scaffold, D1 + R2, inbound pipeline, auth + read UI, sending; plus multi-user (Team) and Phase 6 (usage page, retention, PWA, shortcuts, themes, mobile menu, backups). Phase 7 done: security review, TOTP replay protection, API end-to-end suites (`pnpm e2e`), setup and security docs. Next: self-setup (Deploy button + setup wizard) for other organisations.

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

## Team (multi-user)

The first user (set with `pnpm owner:password`) is an admin. Admins open **Team** in the sidebar to create users
(`name@<allowed domain>`, a temporary password the user must change at first login), reset passwords, change roles,
disable users, and give extra addresses such as `sales@`. Every user sees only their own mail; this is enforced in
every query on the server. Inbound mail is routed by recipient address: an address belongs to exactly one user,
and mail to an unknown address (catch-all) or to a disabled user goes to the first active admin.

## Operations

- **Usage** (admin, sidebar): sends today and this month, D1 size, estimated R2 size, messages per user; warns at 80%.
- **Retention:** the daily cron empties Trash and Spam 30 days after a message was moved there (R2 files first,
  then rows), and removes expired sessions.
- **Backups:** `pnpm backup:remote` writes every D1 table as JSON plus `r2-keys.txt` to `backups/` (gitignored;
  contains password hashes, keep it private). Add `-- --with-mail` to download the R2 files too. To undo recent
  changes use D1 Time Travel (7 days on the free plan): `pnpm exec wrangler d1 time-travel info quadmail`.
- **App:** installable as a PWA (manifest + icons, regenerate with `pnpm icons`), keyboard shortcuts (press `?`),
  light/dark/system theme in Settings, the list refreshes every minute while the tab is visible.

## Database

```bash
pnpm db:migrate:local    # apply migrations to the local Miniflare D1
pnpm db:migrate:quadgentics   # apply migrations to the Quadgentics production D1
pnpm smoke:local         # R2 put/get + D1 insert/FTS/delete against local state
pnpm smoke:remote        # same, against the real bucket and database
```

## Deploying the Quadgentics installation

```bash
pnpm deploy:quadgentics   # migrations + build + deploy of env.quadgentics (wrangler.jsonc)
```

The plain `pnpm run deploy` is for the Deploy button (Workers Builds) and refuses to run elsewhere unless
`QM_GENERIC_DEPLOY=1` is set, so it cannot replace the production Worker by accident.

## License

QuadMail is free software under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html)
(`AGPL-3.0-only`). If you offer a modified version to others over a network, you must publish your changes.
