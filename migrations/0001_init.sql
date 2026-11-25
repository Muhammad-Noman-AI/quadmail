-- QuadMail initial schema. D1 (SQLite) with FTS5.
-- Large data (raw mail, HTML bodies, attachments) lives in R2; D1 holds metadata only.
-- Timestamps are Unix epoch milliseconds (INTEGER). IDs are ULIDs (TEXT).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,
  created_at INTEGER NOT NULL
);

-- id is the SHA-256 of the session token; the raw token only lives in the cookie.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sending_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  signature_html TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, address)
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  subject_norm TEXT NOT NULL DEFAULT '',
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX threads_subject ON threads(subject_norm, last_message_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'drafts', 'archive', 'spam', 'trash')),
  message_id_hdr TEXT,
  in_reply_to TEXT,
  references_json TEXT,
  envelope_from TEXT,
  envelope_to TEXT,
  from_addr TEXT,
  from_name TEXT,
  to_json TEXT,
  cc_json TEXT,
  bcc_json TEXT,
  subject TEXT,
  snippet TEXT,
  search_text TEXT,                 -- capped at 8 KB by the app (D1 Free is 500 MB per database)
  raw_key TEXT,
  html_key TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  parse_status TEXT NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending', 'done', 'failed')),
  parse_error TEXT,
  auth_results TEXT,
  send_status TEXT CHECK (send_status IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
  provider_message_id TEXT,
  received_at INTEGER NOT NULL,
  sent_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX messages_folder_received ON messages(folder, received_at DESC);
CREATE INDEX messages_thread ON messages(thread_id, received_at);
CREATE INDEX messages_message_id_hdr ON messages(message_id_hdr);
CREATE INDEX messages_unread ON messages(folder, is_read);
CREATE INDEX messages_starred ON messages(is_starred) WHERE is_starred = 1;
CREATE INDEX messages_parse_pending ON messages(parse_status) WHERE parse_status <> 'done';
CREATE INDEX messages_provider_id ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX attachments_message ON attachments(message_id);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT
);

CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX message_labels_label ON message_labels(label_id);

CREATE TABLE blocked_senders (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE suppressions (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- day is 'YYYY-MM-DD' in UTC, matching Resend's daily quota window.
CREATE TABLE send_counters (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,             -- 'ip:<addr>' or 'user:<email>'
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX audit_log_at ON audit_log(at DESC);

-- Full-text search. External-content table: text is stored once, in messages.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_addr, from_name, search_text,
  content='messages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_addr, from_name, search_text)
  VALUES (new.rowid, new.subject, new.from_addr, new.from_name, new.search_text);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, search_text)
  VALUES ('delete', old.rowid, old.subject, old.from_addr, old.from_name, old.search_text);
END;

-- Only re-index when indexed columns change, so star/read/move updates cost no FTS writes.
CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, from_addr, from_name, search_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, search_text)
  VALUES ('delete', old.rowid, old.subject, old.from_addr, old.from_name, old.search_text);
  INSERT INTO messages_fts(rowid, subject, from_addr, from_name, search_text)
  VALUES (new.rowid, new.subject, new.from_addr, new.from_name, new.search_text);
END;
