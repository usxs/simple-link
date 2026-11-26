-- 简链 · D1 初始化
-- 应用：wrangler d1 migrations apply simple-link --remote

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS links (
  code         TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  created_day  TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  clicks       INTEGER NOT NULL DEFAULT 0,
  last_click_at INTEGER,
  blocked      INTEGER NOT NULL DEFAULT 0,
  ip_hash      TEXT NOT NULL,
  manage_hash  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_ip_created
  ON links (ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_links_expires
  ON links (expires_at);

CREATE INDEX IF NOT EXISTS idx_links_created
  ON links (created_at DESC);

CREATE TABLE IF NOT EXISTS link_clicks_daily (
  code  TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day)
);

CREATE INDEX IF NOT EXISTS idx_link_clicks_day
  ON link_clicks_daily (day);

CREATE TABLE IF NOT EXISTS link_quota (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);

CREATE INDEX IF NOT EXISTS idx_link_quota_day
  ON link_quota (day);
