CREATE TABLE IF NOT EXISTS external_live_tv_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  channel_key TEXT NOT NULL,
  channel_label TEXT NOT NULL,
  launched_url TEXT,
  tuned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  package_name TEXT,
  device_serial TEXT
);

CREATE INDEX IF NOT EXISTS idx_external_live_tv_state_active
ON external_live_tv_state(is_active, updated_at DESC);
