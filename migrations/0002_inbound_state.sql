-- Small key/value store for background job state (e.g. the R2 reconcile cursor).
CREATE TABLE job_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
