# Self-setup plan: anyone can run their own QuadMail

Status: proposal, waiting for approval (2026-11-26).

## Goal

A person with a domain opens `quadmail.quadgentics.com`, clicks **Get started**, and about 20 minutes later has their
own QuadMail on their own Cloudflare account: receiving, sending, a team, and no command line.

Each organisation runs its own copy (one deployment = one tenant). Quadgentics never sees their mail, keys or
passwords, and pays nothing for their usage.

## What the user needs

- A domain whose DNS is on Cloudflare. Email Routing works only on zones in the same Cloudflare account.
- A Cloudflare account. R2 may ask for a payment method even on the free tier.
- A free Resend account.
- A free GitHub account. The Deploy button copies the code into it.

## The user's journey

1. **Landing page** (`quadmail.quadgentics.com`): what QuadMail is, what it costs (nothing, within the free limits), requirements, and the **Deploy to Cloudflare** button.
2. **Deploy form** (Cloudflare's own page). The user signs in to Cloudflare and GitHub, chooses names, and types a **setup code**: any phrase they choose, which proves they own the deployment. Cloudflare creates the Worker, D1 and R2, runs the migrations, and deploys.
3. **Setup wizard** at their new URL. It appears only while the installation has no users.

   | Step | What happens | Automated? |
   | --- | --- | --- |
   | 1. Unlock | Enter the setup code. Stops anyone else who finds the URL first. | yes |
   | 2. Organisation | Organisation name, domain (`company.com`), admin email (`you@company.com`), password. The admin account is created and signed in. | yes |
   | 3. Resend | Paste a Resend key with **full access**. QuadMail finds or adds the domain, then shows the DNS records in a table with copy buttons. | yes |
   | 4. DNS | The user adds the records in Cloudflare DNS. **Check** asks Resend to verify and also checks SPF, a single DMARC record and MX through DNS-over-HTTPS, with plain explanations. | check: yes; adding: by hand (v1) |
   | 5. Finish sending | QuadMail creates the Resend webhook (the signing secret comes back in the response) and a **sending-only** key for this domain, and stores them. The full-access key is used for this step only and **never stored**. | yes |
   | 6. Receiving | Instructions, with links: turn on Email Routing and set the catch-all to this Worker. QuadMail shows a test address (`setup-7k2p@company.com`) and waits until a mail sent there arrives. | check: yes; switch: by hand |
   | 7. Send test | QuadMail sends a test mail to the admin's personal address and shows the result. | yes |
   | 8. Done | Turn on 2FA, add the team, and learn where Usage is. | |

4. **Updates.** The user's GitHub copy includes a workflow called **"Update QuadMail"**. It runs on a weekly schedule and with one button. It merges the latest QuadMail release into their copy. The push triggers Workers Builds, which runs the migrations and deploys. The app shows **"Update available"** to admins when its version is older than the latest release.

## Technical design

### Configuration moves from wrangler vars to the database

- New `app_config` table (key/value) for organisation name, sending domains, daily limit, `APP_URL`, the Resend sending key and the webhook secret.
- Secrets in it are encrypted with AES-256-GCM. The key is a random master key that is created at setup and stored in R2 (`system/master.key`), not in D1. A D1 export or backup alone does not reveal the secrets.
- The existing variables and secrets still **take precedence** when they are set. Our own installation therefore keeps working unchanged, and no secret moves.
- `APP_URL` comes from the URL the wizard was opened on.
- `TOTP_ENC_KEY` falls back to a key derived from the master key (HKDF).

### Setup API (`/api/setup/*`, only while no user exists)

- Every step requires the setup code (compared in constant time, rate-limited).
- After step 2 the steps also need the new admin's session.
- Calls to Resend from the Worker: `GET /domains`, `POST /domains`, `GET /domains/{id}`, `POST /domains/{id}/verify`, `POST /webhooks`, `POST /api-keys` (with `sending_access` and the domain restriction). Each request sends the required `User-Agent`.
- DNS checks use Cloudflare's DNS-over-HTTPS (`cloudflare-dns.com/dns-query`).

### After setup: Settings → Domains & sending (admin)

- Add a second or third domain (Resend Free allows 3), with the same records table and Check button.
- Change the daily limit; replace the Resend key (paste a full-access key once, and a new sending key is created).

### Packaging for the Deploy button

- `wrangler.jsonc` top level becomes generic: bindings without IDs and without a bucket name (Cloudflare provisions them), and no domain-specific vars.
- Our own production settings move to `env.quadgentics` in the same file. We deploy with `--env quadgentics`. IDs and the domain are not secrets.
- `.dev.vars.example` lists `SETUP_CODE`, with a description in `package.json` → `cloudflare.bindings`.
- `package.json` deploy script: `wrangler d1 migrations apply DB --remote && wrangler deploy`. Migrations always run with a deploy.
- Version number in the build; `.github/workflows/update.yml` for upstream updates.
- A LICENSE file (see the decisions below).

### Landing page

A small separate static Worker in `site/` (fully isolated, as the Deploy button requires) on `quadmail.quadgentics.com`. It holds:

- what QuadMail does,
- requirements and costs,
- the Deploy button,
- a step-by-step guide with screenshots,
- limits (100 mails per day on Resend Free),
- privacy ("your mail stays in your Cloudflare account"),
- an FAQ.

## Work packages (each ends with tests, a commit and a stop for approval)

| # | Package | Main risk | Test |
| --- | --- | --- | --- |
| S1 | Configuration in D1, master key in R2, env vars take precedence | Breaking our live installation | Unit tests, e2e suite unchanged, deploy to ours with nothing to configure |
| S2 | Setup API | The installation being claimed by someone else | e2e: wrong code refused, no setup once a user exists, Resend calls against a mock |
| S3 | Wizard UI | Steps that confuse non-technical users | Run through it locally against a mock Resend |
| S4 | Domains & sending settings | | e2e |
| S5 | Deploy-button packaging, update workflow, version check, LICENSE | Our own deploy changing name or resources | Dry-run deploy of `--env quadgentics`; button flow on a test repo |
| S6 | Public GitHub repository and landing page | Publishing something by mistake | A secrets scan before the first push; you review the repo first |
| S7 | Real trial | | A fresh install from the button on a test subdomain (for example `trial.quadgentics.com`, Email Routing supports subdomains), all 8 wizard steps, a Gmail test |

Rough size: S1–S4 are about as much work as Phase 5. S5–S7 are smaller but need your accounts (GitHub, DNS).

## Decisions needed from you

1. **Public code.** The Deploy button requires a public GitHub repository. Do you agree, and under which GitHub account?
2. **License.**
   - *MIT*: anyone may use and change it, also commercially, with no obligations.
   - *AGPL-3.0*: anyone may use it, but someone who offers a changed version as a service must publish their changes.
   - *Source-available*: free for own use, no reselling.

   Recommendation: AGPL-3.0 if you may later sell hosting or support yourself; MIT if you want the widest use.
3. **Name and address.** Keep "QuadMail" and `quadmail.quadgentics.com`?
4. **The Resend key in the wizard.** Asking once for a full-access key, which is not stored and is replaced by a sending-only key, makes setup automatic. The alternative is manual steps: the user creates the webhook and pastes two values. Recommendation: the automatic way.

## Out of scope for this phase

- Adding DNS records automatically through a Cloudflare API token (planned for v2: it saves step 4, but asks for a powerful token).
- Hosting several organisations in one deployment.
- Billing.
- Moving existing mail from Gmail or another provider into QuadMail.
