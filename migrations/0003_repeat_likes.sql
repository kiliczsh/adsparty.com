CREATE TABLE IF NOT EXISTS like_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_id INTEGER NOT NULL,
  viewer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(clip_id) REFERENCES clips(id)
);

CREATE INDEX IF NOT EXISTS idx_like_events_clip_id
ON like_events(clip_id, id);
