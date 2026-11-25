# Phase 0: Verified limits and implementation plan

Verified 2026-11-19 against official docs. Source pages are named in each row.

## Verified free-tier limits

| Service | Verified limit | Source |
| --- | --- | --- |
| Email Routing | 25 MiB inbound max (larger is rejected); 200 rules per domain; 200 destination addresses per account; a rule can target a Worker | developers.cloudflare.com/email-service/platform/limits |
| Workers Free | 100,000 requests/day; **10 ms CPU** per invocation; 50 subrequests; `waitUntil` up to 30 s; 128 MB memory | workers/platform/limits |
| D1 Free | **500 MB per database**; 5 GB per account; 10 databases; 5M rows read/day; 100k rows written/day; 2 MB max row; 100 KB max statement; 100 bound params; reset at 00:00 UTC; **FTS5 supported** | d1/platform/limits, d1/platform/pricing, d1/sql-api/sql-statements |
| R2 Free | 10 GB-month; 1M Class A/month (Put, List); 10M Class B/month (Get, Head); Delete free; egress free; presigned GET/PUT/HEAD/DELETE (no POST), expiry 1 s to 7 days, **not on custom domains**; browser use needs bucket CORS | r2/pricing, r2/api/s3/presigned-urls |
| Vercel Hobby | 4.5 MB request/response body; function max 300 s; cron **once per day, ±59 min**; 100 crons per project; 4 active CPU-hours/month; ToS §4: "personal or non-commercial use" only | vercel.com/docs/functions/limitations, docs/cron-jobs/usage-and-pricing, legal/terms |
| Resend Free | 3,000/month; 100/day; 3 domains; 1 webhook endpoint (all events); 30-day log retention; max 50 `to`; 40 MB attachments after base64; webhooks signed with Svix (`svix-id`, `svix-timestamp`, `svix-signature`) | resend.com/pricing, resend.com/docs |
| CF Email Sending | Beta, **Workers Paid only** (matches section 14) | developers.cloudflare.com/email-service |

## Differences from the master prompt

1. **D1 is 500 MB per database on Free, not 5 GB.** At a 32 KB `search_text` cap, plus a copy in FTS5, the database fills after about 7,000 to 10,000 messages. Plan: cap `search_text` at **8 KB**, so it holds about 30,000 to 50,000 messages. The usage page tracks database size. If it fills, the next step is one database per year (still free, up to 10 databases).
2. **The Workers CPU limit is 10 ms.** This confirms the design: the Worker only streams to R2, does one D1 insert and sends one webhook. It parses no MIME.
3. **What happens when an email handler throws is not documented.** `setReject()` is a documented permanent SMTP rejection. Plan: on an R2 failure, call `setReject("Temporary storage failure, please retry")`. The sender gets a bounce, so the mail is not lost silently. In Phase 3, test whether a thrown error causes a temporary 4xx failure (the sender then retries) and use that if it does.
4. **Email Routing docs moved** under `/email-service/`. The code will link to the new paths.
5. **Vercel cron runs late by up to 59 minutes** and only once a day. That is fine for reconcile and retention jobs.
6. **R2 presigned URLs do not work on custom domains.** The browser talks to `<account>.r2.cloudflarestorage.com` directly. The bucket needs a CORS rule for `https://mail.DOMAIN` (added to SETUP.md, plus a script).
7. **Resend custom headers:** the `headers` field is documented, but `In-Reply-To`, `References` and `Message-ID` are not listed by name. Resend may replace `Message-ID`. Phase 5 tests this before relying on it. Fallback: store the Message-ID that Resend reports.
8. **Resend Free allows only one webhook endpoint.** That is enough (`/api/webhooks/resend`).
9. **Not yet verified:** rate limits on the Cloudflare D1 REST API. This is checked in Phase 2. If they are too tight, the repository layer switches to a small gateway Worker with a D1 binding (the swap already planned in section 5).
10. The Vercel fair-use page could not be read (a local WebFetch hook crashed). The non-commercial wording comes from the Terms of Service.

## Architecture decision (2026-11-25): Cloudflare only, no Vercel

Mailflare was tried and dropped. The app now runs as **one Cloudflare Worker** on the free plan:

- `email()` handler: size check, stream raw to R2, one D1 insert. No MIME parsing (10 ms CPU limit).
- `fetch()` handler: `/api/*` JSON API over D1 and R2 bindings; everything else is the React SPA from static assets (static asset requests are free and not CPU-limited).
- **Parsing and sanitising happen in the browser** (`postal-mime` + DOMPurify, rendered in a sandboxed iframe). After the first open, the browser posts back snippet, search text and attachment metadata for D1/FTS.
- Attachment uploads stream through the Worker to the R2 binding (Worker request limit is 100 MB, not Vercel's 4.5 MB), so no S3 keys or presigned URLs are needed.
- Daily jobs (retention, reconcile) use Workers Cron Triggers (5 free per account).
- No ingest webhook or HMAC: the Worker writes D1 directly.
- Single package with pnpm, not workspaces: there is only one deployable.

Changes from section 5 of the master prompt: `/apps/web` and `/workers/inbound` merge into `src/worker` + `src/web`; `INGEST_HMAC_SECRET`, `CF_API_TOKEN`, `D1_DATABASE_ID` and the `R2_*` keys are no longer needed.

**Parallel work:** Phases 1 and 2 are sequential. After Phase 2, Phase 3 (inbound) and Phase 4 (auth + read UI on seed data) can run in parallel. Phase 5 needs both.

## Implementation plan

- **Phase 1:** pnpm monorepo (`apps/web`, `workers/inbound`, `packages/shared`), strict TS, ESLint, Vitest, GitHub Actions CI (typecheck, lint, test), zod env schemas, `.env.example`, README skeleton, `git init`.
- **Phase 2:** D1 migrations (all tables from section 6, indexes, FTS5 table, triggers to keep FTS in sync), `wrangler.toml`, migration scripts, R2 CORS script, smoke script that writes and reads one R2 object and one D1 row (REST + S3).
- **Phase 3:** Worker (size check, ULID, stream to R2, minimal insert, signed webhook in `waitUntil`); `/api/ingest` (HMAC + 5 min window, idempotent, postal-mime, sanitize-html, attachments to R2, snippet, 8 KB search text, threading); daily cron for reprocess and reconcile; Reprocess endpoint.
- **Phase 4:** auth (argon2id, TOTP, DB sessions, rate limit, origin check), three-pane UI, thread view, FTS search with filters, folder actions, labels, sandboxed iframe rendering with remote content blocked.
- **Phase 5:** `MailProvider` + `ResendProvider` (+ `CloudflareEmailProvider` behind a flag), send rules (domain allowlist, recipient cap, daily counter, suppressions), compose/reply/forward/drafts, identities, presigned uploads, Svix webhook.
- **Phase 6:** usage page, retention cron, PWA, shortcuts, dark mode, mobile, backup script.
- **Phase 7:** security checklist, unit and Playwright tests, final docs.
