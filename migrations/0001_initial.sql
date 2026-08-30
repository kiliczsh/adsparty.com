CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, msg TEXT NOT NULL,
  created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', rejection_code TEXT,
  job_id TEXT, seen_at INTEGER, generating_at INTEGER, ready_at INTEGER, aired_at INTEGER,
  failed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_status_id ON messages(status,id);
CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY, fal_request_id TEXT UNIQUE, status TEXT NOT NULL, expanded_prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status,created_at);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT, segment_filename TEXT UNIQUE, generation_job_id TEXT UNIQUE,
  prompt TEXT NOT NULL, chat_text TEXT NOT NULL, generated_at INTEGER NOT NULL, duration REAL NOT NULL,
  r2_key TEXT UNIQUE, source TEXT NOT NULL DEFAULT 'generated', ready INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(generation_job_id) REFERENCES generation_jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_clips_ready_id ON clips(ready,id);
CREATE TABLE IF NOT EXISTS clip_messages (
  clip_id INTEGER NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY(clip_id,message_id),
  FOREIGN KEY(clip_id) REFERENCES clips(id), FOREIGN KEY(message_id) REFERENCES messages(id)
);
CREATE TABLE IF NOT EXISTS likes (
  clip_id INTEGER NOT NULL, viewer_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(clip_id,viewer_id), FOREIGN KEY(clip_id) REFERENCES clips(id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS billing_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES
 ('policy','{"nsfw":false,"copyrighted_characters":false,"brands":false,"public_figures":false,"graphic_violence":false,"non_graphic_violence":true}',unixepoch()),
 ('bible','{"props":[],"last_form":null,"previous_setting":null,"previous_owner":null,"note":""}',unixepoch());
