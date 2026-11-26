// Drafts, attachments, send rules and (when QM_WEBHOOK_SECRET matches the dev server's
// RESEND_WEBHOOK_SECRET) the Resend webhook. RESEND_API_KEY must NOT be set locally: sends stop at 503.
import { ADMIN_EMAIL, BASE, adminPassword, check, login, sql, tag, webhook } from "./lib.mjs";

export async function sendSuite() {
  const t = tag();
  const s = await login(ADMIN_EMAIL, adminPassword());
  let x = await s.call("GET", "/api/sending");
  check("sending info lists the admin identity", x.data.identities.some((i) => i.address === ADMIN_EMAIL));
  const providerReady = x.data.providerReady;

  const draft = { from: ADMIN_EMAIL, to: [{ address: "friend@example.com", name: "Evil\r\nBcc: victim@example.com" }], cc: [], bcc: [], subject: `draft-${t}`, html: "<p>Hello <b>e2e</b></p>", text: `Hello zebra${t}` };
  x = await s.call("POST", "/api/drafts", draft);
  const id = x.data?.id;
  check("create draft", x.status === 201);
  check("save draft", (await s.call("PUT", `/api/drafts/${id}`, { ...draft, subject: `draft-${t}-v2` })).status === 200);
  let res = await fetch(`${BASE}/api/drafts/${id}/attachments`, { method: "POST", headers: { cookie: s.cookie, origin: BASE, "content-type": "text/plain", "x-filename": encodeURIComponent("héllo.txt") }, body: "hello world" });
  const att = await res.json();
  check("upload attachment", res.status === 201 && att.filename === "héllo.txt" && att.sizeBytes === 11);
  const detail = (await s.call("GET", `/api/messages/${id}`)).data;
  check("draft detail", detail.folder === "drafts" && detail.bodySource === "body" && detail.attachments.length === 1);
  check("recipient names lose CR/LF (no header injection)", !/[\r\n]/.test(detail.to[0].name ?? ""));
  check("draft body", (await s.call("GET", `/api/messages/${id}/body`)).data?.html?.includes("<b>e2e</b>"));
  res = await fetch(`${BASE}/api/attachments/${att.id}`, { headers: { cookie: s.cookie } });
  check("attachment download", (await res.text()) === "hello world" && res.headers.get("content-type") === "application/octet-stream");
  check("draft is searchable", JSON.stringify((await s.call("GET", `/api/search?q=zebra${t}`)).data).includes(id));
  if (!providerReady) {
    check("send without RESEND_API_KEY stops at 503", (await s.call("POST", `/api/drafts/${id}/send`)).status === 503);
    check("refused send leaves a draft", (await s.call("GET", `/api/messages/${id}`)).data.folder === "drafts");
  }
  x = await s.call("POST", "/api/drafts", { ...draft, from: "ceo@bank.com" });
  check("foreign From refused (no open relay)", (await s.call("POST", `/api/drafts/${x.data.id}/send`)).status === 400);
  await s.call("DELETE", `/api/drafts/${x.data.id}`);

  const secret = process.env.QM_WEBHOOK_SECRET;
  if (secret) {
    await sql(`UPDATE messages SET folder = 'sent', send_status = 'sent', provider_message_id = 'e2e-${t}' WHERE id = '${id}'`);
    check("webhook delivered", (await webhook(secret, { type: "email.delivered", data: { email_id: `e2e-${t}`, message_id: `<resend-${t}@quadgentics.com>`, to: [`bouncy.${t}@example.com`] } })) === 200);
    x = (await s.call("GET", `/api/messages/${id}`)).data;
    check("delivered status and provider Message-ID stored", x.sendStatus === "delivered" && x.messageIdHeader === `<resend-${t}@quadgentics.com>`);
    await webhook(secret, { type: "email.bounced", data: { email_id: `e2e-${t}`, to: [`Bouncy.${t}@example.com`], bounce: { type: "Permanent" } } });
    await webhook(secret, { type: "email.delivered", data: { email_id: `e2e-${t}` } });
    check("a late delivered event does not undo a bounce", (await s.call("GET", `/api/messages/${id}`)).data.sendStatus === "bounced");
    check("bounced address is suppressed", (await s.call("GET", "/api/suppressions")).data.items.some((i) => i.address === `bouncy.${t}@example.com`));
    check("tampered signature refused", (await webhook(secret, { type: "email.delivered", data: { email_id: "x" } }, { tamper: true })) === 401);
    check("stale timestamp refused", (await webhook(secret, { type: "email.delivered", data: { email_id: "x" } }, { timestamp: Math.floor(Date.now() / 1000) - 3600 })) === 401);
    x = await s.call("POST", "/api/drafts", { ...draft, to: [{ address: `bouncy.${t}@example.com` }] });
    check("send to a suppressed address refused", (await s.call("POST", `/api/drafts/${x.data.id}/send`)).status === 400);
    await s.call("DELETE", `/api/drafts/${x.data.id}`);
    await s.call("DELETE", `/api/suppressions/${encodeURIComponent(`bouncy.${t}@example.com`)}`);
    check("a sent message cannot be edited", (await s.call("PUT", `/api/drafts/${id}`, draft)).status === 409);
    await sql(`UPDATE messages SET folder = 'trash', folder_changed_at = 0 WHERE id = '${id}'`);
  } else {
    console.log("SKIP webhook checks (set QM_WEBHOOK_SECRET to the dev server's RESEND_WEBHOOK_SECRET)");
    check("discard draft", (await s.call("DELETE", `/api/drafts/${id}`)).status === 200);
    check("discarded draft is gone", (await s.call("GET", `/api/messages/${id}`)).status === 404);
  }
  res = await fetch(`${BASE}/api/drafts`, { method: "POST", headers: { cookie: s.cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify(draft) });
  check("cross-origin draft create refused", res.status === 403);
}
