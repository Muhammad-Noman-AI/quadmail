// System email (sign-in details for a new user or after a password reset). Sent through the same
// provider and counted against the same daily limit, but never stored: the body holds a password.
import { stripControlChars } from "../../shared/text";
import { ulid } from "../../shared/ulid";
import type { AppConfig } from "../../shared/env";
import { HttpError } from "../http";
import { releaseQuota, reserveQuota } from "../storage/outbound";
import { ProviderError } from "./provider";
import { ResendProvider } from "./resend";
import { formatMailbox, utcDay } from "./rules";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface SignInDetails {
  name: string | null;
  email: string;
  tempPassword: string;
  appUrl: string;
  /** Who set it up, shown to the recipient. */
  adminName: string;
  reset: boolean;
}

export function signInEmail(details: SignInDetails): { subject: string; text: string; html: string } {
  const greeting = details.name ? `Hi ${stripControlChars(details.name).trim()},` : "Hi,";
  const intro = details.reset
    ? `${details.adminName} reset the password of your QuadMail account.`
    : `${details.adminName} created a QuadMail email account for you.`;
  const subject = details.reset ? `Your new temporary password for ${details.email}` : `Your new email account: ${details.email}`;
  const text = [
    greeting,
    "",
    intro,
    "",
    `Email address: ${details.email}`,
    `Temporary password: ${details.tempPassword}`,
    `Sign in at: ${details.appUrl}`,
    "",
    "You will choose your own password when you sign in. If you did not expect this email, ignore it.",
  ].join("\n");
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555">${label}</td><td style="padding:4px 0;font-family:monospace;font-size:15px"><b>${escapeHtml(value)}</b></td></tr>`;
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#171717">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(intro)}</p>
<table style="border-collapse:collapse">${row("Email address", details.email)}${row("Temporary password", details.tempPassword)}</table>
<p><a href="${escapeHtml(details.appUrl)}" style="display:inline-block;background:#2563eb;color:#fff;padding:8px 16px;border-radius:8px;text-decoration:none">Sign in to QuadMail</a></p>
<p style="color:#555">You will choose your own password when you sign in. If you did not expect this email, ignore it.</p>
</div>`;
  return { subject, text, html };
}

/** Send one system email from `from`. Throws HttpError with a message fit for the admin. */
export async function sendSystemEmail(
  db: D1Database,
  cfg: AppConfig,
  from: { address: string; name: string | null },
  to: string,
  message: { subject: string; text: string; html: string },
): Promise<void> {
  if (cfg.MAIL_PROVIDER !== "resend" || !cfg.RESEND_API_KEY) throw new HttpError(503, "Sending is not set up (RESEND_API_KEY missing).");
  const day = utcDay(Date.now());
  if (!(await reserveQuota(db, day, 1, cfg.DAILY_SEND_LIMIT))) throw new HttpError(429, "Today's send limit is reached. Give the details to the user yourself.");
  try {
    await new ResendProvider(cfg.RESEND_API_KEY).send({
      idempotencyKey: ulid(),
      from: formatMailbox(from.address, from.name),
      to: [to],
      cc: [],
      bcc: [],
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: {},
      attachments: [],
    });
  } catch (err) {
    await releaseQuota(db, day, 1).run();
    if (err instanceof ProviderError) throw new HttpError(502, err.message);
    throw err;
  }
}
