# Setting up QuadMail

This guide sets up QuadMail for one domain from nothing. It takes about an hour. Everything runs on free plans:
Cloudflare (Workers, D1, R2, Email Routing) and Resend (sending).

Steps marked **[you]** need a browser and your accounts. The others are commands in this folder.

## What you need

- A domain whose DNS is on Cloudflare (in this guide: `example.com`).
- A Cloudflare account and a Resend account.
- Node 22.18 or later, and pnpm.

## 1. Get the code and log in

```bash
pnpm install
pnpm exec wrangler login
```

## 2. Create the database and the bucket

```bash
pnpm exec wrangler d1 create quadmail
pnpm exec wrangler r2 bucket create quadmail-mail
```

Copy the `database_id` that `d1 create` prints into `wrangler.jsonc` (`d1_databases[0].database_id`).

In `wrangler.jsonc`, under `vars`, set:

| Variable | Value |
| --- | --- |
| `OWNER_EMAIL` | The first admin's address, for example `you@example.com` |
| `ALLOWED_SENDING_DOMAINS` | `example.com`. Several domains go in one list, separated by commas |
| `DAILY_SEND_LIMIT` | `90`. Resend Free allows 100 per day; every To, Cc and Bcc address counts |
| `APP_URL` | Set it in step 5, once you know the address |

Then create the tables:

```bash
pnpm db:migrate:remote
```

## 3. Resend (sending) [you]

1. In Resend, open **Domains** and add `example.com`. In Cloudflare DNS, add the records Resend shows, as **DNS only** (grey cloud). Wait until Resend shows **Verified**.
2. Open **API Keys** and create a key with **Sending access** for that domain. Keep it for step 5.

## 4. DNS checks [you]

In Cloudflare, open **DNS → Records** for `example.com`:

- **SPF:** keep exactly one TXT record on the root that starts with `v=spf1`. It must include `include:_spf.mx.cloudflare.net`. Resend uses its own SPF on the `send` subdomain.
- **DMARC:** keep exactly one TXT record named `_dmarc`, for example `v=DMARC1; p=none; rua=mailto:dmarc@example.com`. Two DMARC records make Gmail report DMARC as failed. After 2 to 4 weeks of clean reports you can change `p=none` to `p=quarantine`.

## 5. Deploy and set the secrets

```bash
pnpm run deploy
```

The command prints the app address, for example `https://quadmail.<your-subdomain>.workers.dev`. Put that address in `APP_URL` in `wrangler.jsonc`, then deploy again.

Set three secrets. Type only the name on the command line. Paste the value when wrangler asks `Enter a secret value`. Never put a value on the command line.

```bash
# 32 random bytes; the command pipes the value straight in, so it never appears on screen
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | pnpm exec wrangler secret put TOTP_ENC_KEY
pnpm exec wrangler secret put RESEND_API_KEY          # the key from step 3
pnpm exec wrangler secret put RESEND_WEBHOOK_SECRET   # see step 6
```

## 6. Resend webhook [you]

The free plan has one webhook endpoint. In Resend, open **Webhooks** and add one:

- **URL:** `https://<app address>/api/webhooks/resend`
- **Events:** `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`

Copy its signing secret (it starts with `whsec_`) into `RESEND_WEBHOOK_SECRET`, as in step 5.

## 7. Create the first admin

```bash
pnpm owner:password --remote
```

The command asks for the password of `OWNER_EMAIL` twice; you do not see what you type. Use a long, unique password. If an admin is ever locked out, run this command again: it also makes that account an active admin.

## 8. Test sending [you]

1. Sign in at the app address.
2. Send a mail to your Gmail address.
3. In Gmail, open the mail, then **⋮ → Show original**. **SPF, DKIM and DMARC must all show PASS.**
4. In QuadMail, open **Sent**. After a minute the message shows **delivered**. This proves the webhook works.

## 9. Receive mail [you]

In Cloudflare, open **Email → Email Routing → Routing rules**. Edit the **Catch-all** rule: set the action to **Send to a Worker** and the destination to `quadmail`. If other rules send a single address elsewhere, point them at `quadmail` as well.

To check:

1. Reply from Gmail. The reply shows in the Inbox, in the same thread as the mail you sent.
2. Send a mail to `bounced@resend.dev`. After a minute it shows **Bounced**, and the address appears under **Settings → Suppressed addresses**.

## 10. Finish

- **Settings → Two-factor login:** turn it on, especially for admins.
- **Team** (sidebar): add users. Optionally enter each user's personal email to send them their sign-in details.
- **Usage** (sidebar): check the free-tier meters now and then.
- **Backups:** run `pnpm backup:remote` regularly and keep the output private. Add `-- --with-mail` to also download the mail files. To undo the last few days, use D1 Time Travel (7 days on the free plan): `pnpm exec wrangler d1 time-travel info quadmail`.

## Updating

```bash
git pull
pnpm install
pnpm check
pnpm db:migrate:remote   # only when migrations/ has new files
pnpm run deploy
```

Before a migration, save a restore point:

```bash
pnpm exec wrangler d1 time-travel info quadmail
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # set TOTP_ENC_KEY; leave RESEND_API_KEY empty so nothing is really sent
pnpm db:migrate:local
pnpm owner:password              # local admin
pnpm seed:local                  # optional sample mail
pnpm dev                         # http://localhost:5173
pnpm check                       # typecheck, lint, unit tests
QM_ADMIN_PASSWORD_FILE=/path/to/password-file pnpm e2e   # API end-to-end suites, with pnpm dev running
```

To deliver a test mail locally:

```bash
curl -X POST "http://localhost:5173/cdn-cgi/handler/email?from=a@gmail.com&to=you@example.com" --data-binary @test/fixtures/plain.eml
```
