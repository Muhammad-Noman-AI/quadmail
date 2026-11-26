# Security

This document describes what QuadMail protects, how, and what is out of scope. Report a problem to the
admin of your installation.

## What is protected

- **The mail of each user.** Bodies and attachments are in R2; metadata is in D1. Each user must see only their own mail.
- **Accounts.** A stolen password alone must not be enough, and a guessed password must be slow to try.
- **The domain's reputation.** QuadMail must never relay mail for strangers.

## Threats and defences

| Threat | Defence | Where |
| --- | --- | --- |
| Password guessing | 600,000 PBKDF2-SHA256 iterations in the browser. The server stores only a salted HMAC of the result, so a leaked database still costs 600,000 iterations per guess. 5 failures per 15 minutes per IP and per account, on login and on password change. | `src/web/auth/kdf.ts`, `src/worker/auth/password.ts`, `rate-limit.ts` |
| Account discovery | Unknown email, wrong password, disabled account and wrong code all get the same error, and an unknown email takes as long as a wrong password. | `src/worker/routes/auth.ts` |
| Stolen password | Optional TOTP (RFC 6238). A code is accepted once; the step used to turn 2FA on cannot log in. The TOTP secret is encrypted at rest with AES-256-GCM (`TOTP_ENC_KEY`). | `auth/totp.ts`, `routes/auth.ts`, `auth/crypto.ts` |
| Session theft | A random 32-byte token in a `__Host-` cookie that is `HttpOnly`, `Secure` and `SameSite=Lax`. Only its SHA-256 is stored. Sessions last 30 days. "Sign out everywhere", a password change, a reset and disabling a user all end sessions. | `auth/session.ts` |
| Cross-site request forgery | Every POST, PUT, PATCH and DELETE needs an `Origin` equal to `APP_URL` or the request's own origin. The Resend webhook uses its signature instead. | `assertSameOrigin` in `auth/session.ts` |
| One user reading another's mail | Every query on messages, drafts, attachments, threads, labels, blocked senders and search filters on the signed-in user's `user_id`, on the server. Inbound mail gets its owner from the recipient address; an address belongs to exactly one user. The e2e suite (`test/e2e/team.mjs`) checks that an admin cannot open, list, search, change or delete a member's mail. | `storage/*.ts`, `routes/*.ts` |
| A member taking someone's address | Only admins add or remove addresses. Members cannot see Team or Usage. There is always one active admin, and admins cannot disable or demote themselves. | `routes/team.ts` |
| Hostile email HTML (scripts, forms, tracking, CSS exfiltration) | DOMPurify with a strict allowlist plus CSS filtering. Mail renders in an `<iframe sandbox>` without `allow-scripts`, with its own CSP (`default-src 'none'`). Remote images and fonts are blocked until the reader allows them. Links open with `noopener noreferrer`. `allow-same-origin` is set only so the app can read the frame's height: without scripts the frame cannot use that origin. 14 hostile-HTML unit tests. | `src/web/reader/sanitize.ts`, `MessageBody.tsx` |
| Malicious attachments | Always served as `application/octet-stream` with `Content-Disposition: attachment` and `nosniff`; never rendered inline. | `routes/inbound.ts` |
| Open relay / spoofing | From must be one of the sender's own identities on `ALLOWED_SENDING_DOMAINS`. At most 20 recipients. Daily limit (each recipient counts), reserved atomically. Suppressed addresses are refused. CR, LF and other control characters are removed from display names (no header injection). | `send/rules.ts`, `routes/send.ts` |
| Duplicate sends | The draft is claimed atomically; Resend's `Idempotency-Key` stays the same until the draft changes. | `storage/outbound.ts` |
| Forged delivery events | Svix HMAC-SHA256 signature with constant-time comparison, a 5-minute timestamp window and a 256 KB size cap. | `send/webhook.ts` |
| Search injection | FTS5 terms are always quoted; LIKE patterns are escaped. All SQL uses bound parameters. | `storage/mail.ts` |
| Data loss on inbound | The raw mail is written to R2 before anything else. A failed D1 insert is repaired by the daily reconcile. Retention deletes R2 files before rows, so purged mail cannot come back. | `inbound/email.ts`, `inbound/reconcile.ts`, `storage/retention.ts` |
| Leaking secrets in logs | Logs hold ids and error messages only, never bodies, passwords or tokens. The audit log records logins, sends, deletes and settings changes, with ids only. | `auth/respond.ts` |
| Clickjacking and MIME sniffing | Global security headers: CSP, HSTS, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, a strict Referrer-Policy and a Permissions-Policy. | `public/_headers`, `withApiHeaders` |

## Accepted risks

- **Temporary passwords by email.** When an admin chooses to email sign-in details, the temporary password passes through the Worker (over TLS) to Resend and sits in the recipient's mailbox. It is never stored or logged, and the user must replace it at the first sign-in. Leave the personal email empty to hand it over another way.
- **Admins can reset any member's password.** Resetting does not reveal existing mail, but the admin then knows the temporary password. This is how most company mail works.
- **Mail is not end-to-end encrypted.** It is stored in plain form in the Cloudflare account, like most webmail. Whoever controls that account (and Cloudflare itself) can read it.
- **The browser derives the password key.** A compromised browser or extension can capture passwords, as with any web login.
- **Remote images, once allowed, reveal that you opened the mail**, to the sender of that mail.

## Out of scope (v1)

IMAP, POP3 and SMTP access; PGP and S/MIME; scanning attachments for malware (the recipient's device should do
this); spam filtering beyond blocked senders and Gmail-side authentication results (QuadMail shows a warning when
SPF, DKIM or DMARC failed); and protecting against someone who controls the Cloudflare or Resend account.

## Operational checklist

- [ ] Every admin has 2FA turned on.
- [ ] `TOTP_ENC_KEY`, `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` exist only as Worker secrets, never in git.
- [ ] Old API keys (for example from earlier tools) are revoked in Resend.
- [ ] Exactly one SPF record and one DMARC record exist; after clean reports, raise DMARC to `p=quarantine`.
- [ ] Backups (`pnpm backup:remote`) are kept private: they contain password hashes and mail metadata.
- [ ] Users who leave are disabled, not deleted, so their mail and addresses stay with the organisation.
