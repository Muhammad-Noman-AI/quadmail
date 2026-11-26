// Retention (via the scheduled handler), usage, folder-change time, threading of reconciled mail.
import { ADMIN_EMAIL, adminPassword, check, deliver, login, runCron, sql, tag } from "./lib.mjs";

export async function opsSuite() {
  const t = tag();
  const s = await login(ADMIN_EMAIL, adminPassword());
  await deliver(ADMIN_EMAIL, `${t}-old`);
  await deliver(ADMIN_EMAIL, `${t}-new`);
  const rows = await sql(`SELECT id, subject FROM messages WHERE subject LIKE '${t}-%'`);
  const old = rows.find((r) => r.subject === `${t}-old`);
  const fresh = rows.find((r) => r.subject === `${t}-new`);
  check("test mails delivered", !!old && !!fresh);
  await s.call("PATCH", "/api/messages", { ids: [old.id, fresh.id], folder: "trash" });
  const moved = (await sql(`SELECT folder_changed_at FROM messages WHERE id = '${fresh.id}'`))[0];
  check("moving to Trash records the time", moved?.folder_changed_at > Date.now() - 60_000);
  await sql(`UPDATE messages SET folder_changed_at = ${Date.now() - 31 * 24 * 3600 * 1000} WHERE id = '${old.id}'`);
  check("scheduled handler runs", await runCron());
  await new Promise((r) => setTimeout(r, 1500));
  const left = await sql(`SELECT id FROM messages WHERE id IN ('${old.id}', '${fresh.id}')`);
  check("trashed 31 days ago: purged", !left.some((r) => r.id === old.id));
  check("trashed today: kept", left.some((r) => r.id === fresh.id));
  await runCron();
  await new Promise((r) => setTimeout(r, 1500));
  check("purged mail is not brought back by reconcile", (await sql(`SELECT count(*) AS n FROM messages WHERE id = '${old.id}'`))[0]?.n === 0);

  // A message stored without headers (as reconcile does) gets its thread when the browser indexes it.
  const reply = `${t}-reply`;
  await deliver(ADMIN_EMAIL, reply, `In-Reply-To: <${t}-parent@gmail.com>\r\n`);
  const r = (await sql(`SELECT id FROM messages WHERE subject = '${reply}'`))[0];
  await sql(`UPDATE messages SET thread_id = NULL, message_id_hdr = NULL, in_reply_to = NULL, parse_status = 'pending' WHERE id = '${r.id}'`);
  const posted = await s.call("POST", `/api/messages/${r.id}/parsed`, {
    from: { address: "friend@gmail.com" },
    to: [{ address: ADMIN_EMAIL }],
    cc: [],
    subject: reply,
    snippet: "x",
    searchText: "x",
    messageId: `<${t}-child@gmail.com>`,
    inReplyTo: `<${t}-parent@gmail.com>`,
    references: `<${t}-parent@gmail.com>`,
    attachments: [],
  });
  const after = (await sql(`SELECT thread_id, message_id_hdr, in_reply_to FROM messages WHERE id = '${r.id}'`))[0];
  check("reconciled mail is threaded on index", posted.status === 200 && !!after?.thread_id && after.message_id_hdr === `<${t}-child@gmail.com>` && after.in_reply_to === `<${t}-parent@gmail.com>`, JSON.stringify(after));

  const usage = (await s.call("GET", "/api/usage")).data;
  check("usage API", usage.d1Bytes > 0 && usage.d1LimitBytes === 500 * 1024 * 1024 && usage.retentionDays === 30 && Array.isArray(usage.perUser));

  await sql(`UPDATE messages SET folder = 'trash', folder_changed_at = 0 WHERE id IN ('${fresh.id}', '${r.id}')`);
}
