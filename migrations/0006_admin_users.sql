CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK(role = 'admin'),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY(admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
  ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
  ON admin_sessions(admin_user_id,expires_at);
