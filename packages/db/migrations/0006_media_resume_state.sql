CREATE TABLE IF NOT EXISTS media_resume_state (
  media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  playback_position_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
