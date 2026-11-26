-- 简链 · 所有者、管理员与通行密钥
-- 应用：wrangler d1 migrations apply simple-link --remote

ALTER TABLE links ADD COLUMN owner_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_links_owner_created
  ON links (owner_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id         TEXT PRIMARY KEY,
  method     TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
  ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_passkeys (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL DEFAULT 'admin',
  name         TEXT NOT NULL DEFAULT '通行密钥',
  public_key   TEXT NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip_hash  TEXT NOT NULL,
  ts       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts
  ON admin_login_attempts (ip_hash, ts);
