-- Admin tools: a key/value store for the site-wide announcement, and a log of
-- staff actions (who deleted an account, sent a PIN or changed the banner).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS admin_log_at_idx ON admin_log (at);
