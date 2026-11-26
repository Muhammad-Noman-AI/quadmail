// Multi-user: Team API, mailbox isolation, recipient routing, disable/reset, sign-in email, TOTP replay.
import { createHmac } from "node:crypto";
import { ADMIN_EMAIL, adminPassword, check, deliver, derivePasswordKey, login, sql, tag } from "./lib.mjs";

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of input) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export async function teamSuite() {
  const t = tag();
  const ali = `ali.${t}@quadgentics.com`;
  const sales = `sales.${t}@quadgentics.com`;
  const nobody = `nobody.${t}@quadgentics.com`;
  const admin = await login(ADMIN_EMAIL, adminPassword());
  check("admin login", admin.status === 200, String(admin.status));
  const me = (await admin.call("GET", "/api/me")).data;
  check("admin role", me.role === "admin");

  const temp = "TempPass12345";
  let x = await admin.call("POST", "/api/team", {
    email: ali,
    displayName: "Ali Test",
    role: "member",
    passwordKey: await derivePasswordKey(ali, temp),
    recoveryEmail: `ali.personal.${t}@example.com`,
    tempPassword: temp,
  });
  const aliId = x.data?.id;
  check("admin creates user with a personal email", x.status === 201, String(x.status));
  check("invite email is attempted and reported (no Resend key locally)", x.data?.invite?.sent === false && typeof x.data?.invite?.error === "string", JSON.stringify(x.data?.invite));
  x = await admin.call("POST", "/api/team", { email: ali, role: "member", passwordKey: await derivePasswordKey(ali, temp) });
  check("duplicate user refused", x.status === 409);
  x = await admin.call("POST", "/api/team", { email: "someone@gmail.com", role: "member", passwordKey: await derivePasswordKey("someone@gmail.com", temp) });
  check("other-domain user refused", x.status === 400);
  x = await admin.call("POST", "/api/team", { email: `bob.${t}@quadgentics.com`, role: "member", passwordKey: await derivePasswordKey(ali, temp), tempPassword: temp });
  check("emailing a password without a personal email refused", x.status === 400);
  x = await admin.call("GET", "/api/team");
  const listed = x.data.items.find((m) => m.email === ali);
  check("team list shows the user and personal email", listed?.mustChangePassword === true && listed?.recoveryEmail === `ali.personal.${t}@example.com`);

  let aliS = await login(ali, temp);
  check("new user must change password", aliS.data.mustChangePassword === true);
  check("member cannot see team", (await aliS.call("GET", "/api/team")).status === 403);
  check("member cannot claim addresses", (await aliS.call("POST", `/api/team/${aliId}/addresses`, { address: `ceo.${t}@quadgentics.com` })).status === 403);
  check("member cannot see usage", (await aliS.call("GET", "/api/usage")).status === 403);
  x = await aliS.call("POST", "/api/auth/password", { currentKey: await derivePasswordKey(ali, temp), newKey: await derivePasswordKey(ali, "AliOwnPass2026") });
  check("password change", x.status === 200);
  check("must-change flag cleared", (await aliS.call("GET", "/api/me")).data.mustChangePassword === false);

  check("deliver to ali", (await deliver(ali, `for-ali-${t}`)) < 300);
  check("deliver to unknown address", (await deliver(nobody, `for-nobody-${t}`)) < 300);
  const aliInbox = (await aliS.call("GET", "/api/messages?folder=inbox&limit=100")).data.items;
  const adminInbox = (await admin.call("GET", "/api/messages?folder=inbox&limit=100")).data.items;
  const aliMsg = aliInbox.find((m) => m.subject === `for-ali-${t}`);
  check("ali receives ali@ mail", !!aliMsg);
  check("catch-all goes to admin, not ali", adminInbox.some((m) => m.subject === `for-nobody-${t}`) && !aliInbox.some((m) => m.subject === `for-nobody-${t}`));
  check("admin does not see ali's mail", !adminInbox.some((m) => m.subject === `for-ali-${t}`));
  check("admin cannot open ali's message", (await admin.call("GET", `/api/messages/${aliMsg.id}`)).status === 404);
  check("admin cannot fetch ali's raw", (await admin.call("GET", `/api/messages/${aliMsg.id}/raw`)).status === 404);
  check("admin cannot open ali's thread", (await admin.call("GET", `/api/threads/${aliMsg.threadId}`)).status === 404);
  await admin.call("PATCH", "/api/messages", { ids: [aliMsg.id], folder: "trash" });
  check("admin bulk action does not touch ali's mail", (await aliS.call("GET", `/api/messages/${aliMsg.id}`)).data.folder === "inbox");
  check("admin search does not find ali's mail", !JSON.stringify((await admin.call("GET", `/api/search?q=for-ali-${t}`)).data).includes(aliMsg.id));

  x = await aliS.call("POST", "/api/drafts", { from: ali, to: [{ address: "x@example.com" }], cc: [], bcc: [], subject: `ali-draft-${t}`, html: "<p>hi</p>", text: "hi" });
  const draftId = x.data.id;
  check("admin cannot read ali's draft", (await admin.call("GET", `/api/messages/${draftId}/body`)).status === 404);
  check("admin cannot overwrite ali's draft", (await admin.call("PUT", `/api/drafts/${draftId}`, { from: ADMIN_EMAIL, to: [], cc: [], bcc: [], subject: "x", html: "", text: "" })).status === 409);
  x = await aliS.call("POST", "/api/drafts", { from: ADMIN_EMAIL, to: [{ address: "x@example.com" }], cc: [], bcc: [], subject: "spoof", html: "", text: "" });
  check("ali cannot send as the admin", (await aliS.call("POST", `/api/drafts/${x.data.id}/send`)).status === 400);

  const aliLabel = (await aliS.call("POST", "/api/labels", { name: `Work-${t}` })).data.id;
  x = await admin.call("POST", "/api/labels", { name: `Work-${t}` });
  const adminLabel = x.data.id;
  check("label names are per user", x.status === 201);
  await admin.call("DELETE", `/api/labels/${aliLabel}`);
  check("admin cannot delete ali's label", (await aliS.call("GET", "/api/labels")).data.items.some((l) => l.id === aliLabel));

  check("admin gives ali an extra address", (await admin.call("POST", `/api/team/${aliId}/addresses`, { address: sales })).status === 201);
  await deliver(sales, `for-sales-${t}`);
  check("extra address lands in ali's inbox", (await aliS.call("GET", "/api/messages?folder=inbox&limit=100")).data.items.some((m) => m.subject === `for-sales-${t}`));
  check("an address cannot belong to two users", (await admin.call("POST", `/api/team/${me.id}/addresses`, { address: sales })).status === 409);

  // TOTP: a code works once (RFC 6238 replay protection).
  const setup = (await aliS.call("POST", "/api/auth/totp/setup")).data;
  const step = Math.floor(Date.now() / 30_000);
  check("enable 2FA", (await aliS.call("POST", "/api/auth/totp/enable", { secret: setup.secret, code: totpCode(setup.secret, step) })).status === 200);
  check("the code used to enable 2FA cannot log in", (await login(ali, "AliOwnPass2026", totpCode(setup.secret, step))).status === 401);
  const next = totpCode(setup.secret, step + 1);
  check("a fresh code logs in", (await login(ali, "AliOwnPass2026", next)).status === 200);
  check("the same code cannot log in twice", (await login(ali, "AliOwnPass2026", next)).status === 401);

  check("admin cannot disable self", (await admin.call("PATCH", `/api/team/${me.id}`, { disabled: true })).status === 400);
  check("admin disables ali", (await admin.call("PATCH", `/api/team/${aliId}`, { disabled: true })).status === 200);
  check("disabled user's session stops working", (await aliS.call("GET", "/api/me")).status === 401);
  await deliver(ali, `while-disabled-${t}`);
  check("mail for a disabled user goes to admin", (await admin.call("GET", "/api/messages?folder=inbox&limit=100")).data.items.some((m) => m.subject === `while-disabled-${t}`));
  x = await admin.call("PATCH", `/api/team/${aliId}`, { disabled: false, passwordKey: await derivePasswordKey(ali, "ResetTemp98765"), tempPassword: "ResetTemp98765" });
  check("reset with email: reset done, email reported", x.status === 200 && x.data.emailed?.sent === false && typeof x.data.emailed?.error === "string", JSON.stringify(x.data));
  // The step+1 code was used above (and is still current), so the replay guard would refuse it: allow it once more.
  await sql(`UPDATE users SET totp_last_step = NULL WHERE id = '${aliId}'`);
  aliS = await login(ali, "ResetTemp98765", totpCode(setup.secret, Math.floor(Date.now() / 30_000) + 1));
  check("reset password must be changed", aliS.status === 200 && aliS.data.mustChangePassword === true, String(aliS.status));
  const cross = await fetch(`${process.env.QM_BASE ?? "http://localhost:5173"}/api/team`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  check("cross-origin team call refused", cross.status === 403);

  // Cleanup through retention, so rows and R2 files both go (deleting rows alone lets reconcile bring them back).
  await sql(`UPDATE messages SET folder = 'trash', folder_changed_at = 0 WHERE user_id = '${aliId}' OR subject IN ('for-nobody-${t}', 'while-disabled-${t}')`);
  return async () => {
    await sql(`DELETE FROM labels WHERE id = '${adminLabel}'`);
    await sql(`DELETE FROM messages WHERE user_id = '${aliId}'`);
    await sql(`DELETE FROM sessions WHERE user_id = '${aliId}'`);
    await sql(`DELETE FROM users WHERE id = '${aliId}'`);
  };
}
