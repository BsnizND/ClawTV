ALTER TABLE media_items ADD COLUMN view_count INTEGER;
ALTER TABLE media_items ADD COLUMN last_viewed_at TEXT;
ALTER TABLE media_items ADD COLUMN view_offset_ms INTEGER;
ALTER TABLE media_items ADD COLUMN user_rating REAL;
ALTER TABLE media_items ADD COLUMN audience_rating REAL;
ALTER TABLE media_items ADD COLUMN critic_rating REAL;

CREATE INDEX IF NOT EXISTS idx_media_items_audience_rating ON media_items(audience_rating DESC);
CREATE INDEX IF NOT EXISTS idx_media_items_last_viewed_at ON media_items(last_viewed_at DESC);
