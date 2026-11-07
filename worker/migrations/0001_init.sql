-- Crossing Mode on Cloudflare D1 (SQLite).
--
-- Privacy model:
--   * trips / pings / window_reports feed the public estimate and are
--     anonymous: a trip is keyed by a random UUID; its link to a personal
--     history (history_hash) is cleared as soon as the trip is finalised.
--   * Raw pings are deleted after 48 hours.
--   * Personal journey history is opt-in. It is keyed by the SHA-256 hash of
--     a random history key held on the user's device (no name or phone
--     number), and each journey expires after the user's chosen retention
--     period (7, 30, 60 or 90 days).

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  history_hash TEXT,
  mode TEXT NOT NULL DEFAULT 'vehicle' CHECK (mode IN ('vehicle', 'pedestrian')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned', 'invalid')),
  direction TEXT CHECK (direction IN ('LS_to_SA', 'SA_to_LS')),
  started_at TEXT NOT NULL,
  last_ping_at TEXT,
  current_zone TEXT,
  ping_count INTEGER NOT NULL DEFAULT 0,
  crossing_started_at TEXT,
  crossing_ended_at TEXT,
  total_minutes REAL,
  queue_minutes REAL,
  origin_post_minutes REAL,
  bridge_minutes REAL,
  dest_post_minutes REAL,
  finalised_at TEXT,
  zones_version TEXT
);
CREATE INDEX IF NOT EXISTS trips_active_idx ON trips (status, last_ping_at);
CREATE INDEX IF NOT EXISTS trips_completed_idx ON trips (status, crossing_ended_at);

CREATE TABLE IF NOT EXISTS pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  speed_mps REAL,
  zone TEXT
);
CREATE INDEX IF NOT EXISTS pings_trip_idx ON pings (trip_id, ts);
CREATE INDEX IF NOT EXISTS pings_ts_idx ON pings (ts);

CREATE TABLE IF NOT EXISTS window_reports (
  id TEXT PRIMARY KEY,
  reported_at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LS_to_SA', 'SA_to_LS')),
  post TEXT NOT NULL CHECK (post IN ('ls_departure', 'sa_arrival', 'sa_departure', 'ls_arrival')),
  mode TEXT NOT NULL DEFAULT 'vehicle' CHECK (mode IN ('vehicle', 'pedestrian')),
  windows_open INTEGER,
  people_ahead INTEGER,
  minutes_at_window REAL,
  queue_minutes REAL
);
CREATE INDEX IF NOT EXISTS window_reports_idx ON window_reports (reported_at);

CREATE TABLE IF NOT EXISTS histories (
  key_hash TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days IN (7, 30, 60, 90)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS journeys (
  id TEXT PRIMARY KEY,
  history_hash TEXT NOT NULL REFERENCES histories(key_hash) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  mode TEXT NOT NULL,
  crossing_started_at TEXT NOT NULL,
  crossing_ended_at TEXT NOT NULL,
  total_minutes REAL NOT NULL,
  queue_minutes REAL,
  origin_post_minutes REAL,
  bridge_minutes REAL,
  dest_post_minutes REAL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journeys_history_idx ON journeys (history_hash, crossing_ended_at);
CREATE INDEX IF NOT EXISTS journeys_expiry_idx ON journeys (expires_at);
