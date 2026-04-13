CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  plex_library_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_items (
  id TEXT PRIMARY KEY,
  plex_rating_key TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  media_type TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_title TEXT,
  summary TEXT,
  originally_available_at TEXT,
  year INTEGER,
  duration_ms INTEGER,
  poster_url TEXT,
  thumb_url TEXT,
  added_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shows (
  media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS seasons (
  media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  show_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,
  season_number INTEGER
);

CREATE TABLE IF NOT EXISTS episodes (
  media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  show_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,
  season_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,
  episode_number INTEGER,
  air_date TEXT
);

CREATE TABLE IF NOT EXISTS movies (
  media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  plex_collection_key TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  title TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, media_item_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  session_name TEXT NOT NULL,
  session_type TEXT NOT NULL,
  client_id TEXT NOT NULL,
  claimed INTEGER NOT NULL,
  active INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queues (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  media_item_id TEXT REFERENCES media_items(id),
  position INTEGER NOT NULL,
  origin_reason TEXT NOT NULL,
  requested_title TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playback_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  queue_id TEXT REFERENCES queues(id),
  current_queue_item_id TEXT REFERENCES queue_items(id),
  player_state TEXT NOT NULL,
  playback_position_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_log (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  source TEXT NOT NULL,
  command_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  libraries_synced INTEGER NOT NULL,
  media_items_synced INTEGER NOT NULL,
  error_message TEXT,
  details_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_items_title ON media_items(title);
CREATE INDEX IF NOT EXISTS idx_episodes_show_id ON episodes(show_id);
CREATE INDEX IF NOT EXISTS idx_collections_title ON collections(title);
CREATE INDEX IF NOT EXISTS idx_command_log_created_at ON command_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at DESC);
