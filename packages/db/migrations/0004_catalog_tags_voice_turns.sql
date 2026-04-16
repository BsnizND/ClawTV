CREATE TABLE IF NOT EXISTS media_item_tags (
  media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  tag_type TEXT NOT NULL,
  tag_key TEXT,
  tag TEXT NOT NULL,
  PRIMARY KEY (media_item_id, tag_type, tag)
);

CREATE INDEX IF NOT EXISTS idx_media_item_tags_type_tag ON media_item_tags(tag_type, tag);
CREATE INDEX IF NOT EXISTS idx_media_item_tags_media_item_id ON media_item_tags(media_item_id);

CREATE TABLE IF NOT EXISTS voice_turn_log (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  transcript TEXT NOT NULL,
  raw_reply_text TEXT,
  raw_command_name TEXT,
  raw_payload_json TEXT,
  raw_expects_reply INTEGER,
  final_reply_text TEXT NOT NULL,
  final_command_name TEXT NOT NULL,
  final_payload_json TEXT NOT NULL,
  command_ok INTEGER,
  command_message TEXT,
  matched_item_count INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_turn_log_created_at ON voice_turn_log(created_at DESC);
