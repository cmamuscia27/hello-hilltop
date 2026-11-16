-- Curated neighbor notes. The 4-hour news refresh only rewrites news_items
-- and must never delete these rows. A page hides a row when expires_at (UTC
-- ISO-8601) is in the past. Null expires_at means it stays until deleted.
-- wrangler deploy does not apply this file.

CREATE TABLE IF NOT EXISTS neighbor_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  link TEXT,
  source_name TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS neighbor_updates_expires ON neighbor_updates (expires_at, id);
