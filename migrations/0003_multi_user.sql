-- Multi-user: every message, label and blocked sender belongs to one user; users have roles.
-- Existing data belongs to the first (owner) user, who becomes the admin.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
UPDATE users SET role = 'admin';

ALTER TABLE messages ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE messages SET user_id = (SELECT id FROM users ORDER BY created_at LIMIT 1);
CREATE INDEX messages_user_folder_received ON messages(user_id, folder, received_at DESC);
CREATE INDEX messages_user_message_id_hdr ON messages(user_id, message_id_hdr);

-- Inbound mail is routed by recipient address, so an address belongs to exactly one user.
-- Every user's login address is one of their identities.
INSERT INTO identities (id, user_id, address, display_name, signature_html, is_default)
  SELECT upper(hex(randomblob(13))), u.id, lower(u.email), NULL, NULL,
         CASE WHEN EXISTS (SELECT 1 FROM identities d WHERE d.user_id = u.id AND d.is_default = 1) THEN 0 ELSE 1 END
  FROM users u
  WHERE NOT EXISTS (SELECT 1 FROM identities i WHERE i.address = u.email);
CREATE UNIQUE INDEX identities_address ON identities(address);

-- Labels become per user (name unique per user, not globally). SQLite cannot change a UNIQUE
-- constraint in place, so both label tables are rebuilt; the old ones are dropped child first.
CREATE TABLE labels_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT,
  UNIQUE (user_id, name)
);
INSERT INTO labels_v2 (id, user_id, name, color)
  SELECT id, (SELECT id FROM users ORDER BY created_at LIMIT 1), name, color FROM labels WHERE EXISTS (SELECT 1 FROM users);
CREATE TABLE message_labels_v2 (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels_v2(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);
INSERT INTO message_labels_v2 (message_id, label_id) SELECT message_id, label_id FROM message_labels WHERE label_id IN (SELECT id FROM labels_v2);
DROP TABLE message_labels;
DROP TABLE labels;
ALTER TABLE labels_v2 RENAME TO labels;
ALTER TABLE message_labels_v2 RENAME TO message_labels;
CREATE INDEX message_labels_label ON message_labels(label_id);

-- Blocked senders become per user.
CREATE TABLE blocked_senders_v2 (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, address)
);
INSERT INTO blocked_senders_v2 (user_id, address, created_at)
  SELECT (SELECT id FROM users ORDER BY created_at LIMIT 1), address, created_at FROM blocked_senders WHERE EXISTS (SELECT 1 FROM users);
DROP TABLE blocked_senders;
ALTER TABLE blocked_senders_v2 RENAME TO blocked_senders;
