-- Accounts (email + PIN), 7-day sessions, and saved route maps.
--
-- * Sign-in is email + a 6-digit PIN. The first PIN is emailed to the user;
--   "Forgot PIN" emails a new one that replaces it; users can change it.
--   PINs are stored only as salted PBKDF2 hashes. Five wrong attempts lock
--   the account for 15 minutes.
-- * Session tokens are stored only as SHA-256 hashes and last 7 days.
-- * A user owns at most one history (histories.key_hash); journeys keep
--   pointing at the history, so retention and deletion work as before.
-- * journeys.route holds the simplified route of a saved crossing as JSON
--   [[lat, lng, seconds_since_start], ...]; it is deleted with the journey.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  prefs TEXT NOT NULL DEFAULT '{}',
  history_hash TEXT REFERENCES histories(key_hash) ON DELETE SET NULL,
  pin_hash TEXT,
  pin_salt TEXT,
  pin_set_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  pin_emails_sent INTEGER NOT NULL DEFAULT 0,
  pin_email_window_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

ALTER TABLE journeys ADD COLUMN route TEXT;
