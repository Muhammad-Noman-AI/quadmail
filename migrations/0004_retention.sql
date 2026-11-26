-- When a message last changed folder, so Trash and Spam can be emptied 30 days after the move
-- (not 30 days after it arrived). NULL means "never moved": received_at is used instead.
ALTER TABLE messages ADD COLUMN folder_changed_at INTEGER;
CREATE INDEX messages_retention ON messages(folder, COALESCE(folder_changed_at, received_at)) WHERE folder IN ('trash', 'spam');
