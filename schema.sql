CREATE TABLE IF NOT EXISTS digireview_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS digireview_kv_expires_at_idx
  ON digireview_kv (expires_at) WHERE expires_at IS NOT NULL;
