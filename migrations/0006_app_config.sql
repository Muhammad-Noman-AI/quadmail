-- Installation settings written by the setup wizard and Settings → Domains & sending.
-- Worker vars and secrets with the same meaning take precedence (src/worker/config.ts).
-- Secret values are AES-GCM encrypted with a key derived from the master key in R2 (system/master.key).
CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
