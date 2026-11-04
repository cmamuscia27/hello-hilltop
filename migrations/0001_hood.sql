-- What's happening in your hood.
-- Event clocks are America/Denver in starts_local / ends_local.
-- starts_at, ends_at, and visible_until are UTC instants (ISO-8601) so past
-- events drop off with a plain text comparison. created_at stays UTC, like
-- the other tables. News rows are a cache filled by the cron, never by a
-- page view reading a feed.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  starts_local TEXT NOT NULL,
  ends_at TEXT,
  ends_local TEXT,
  visible_until TEXT NOT NULL,
  location TEXT NOT NULL,
  description TEXT NOT NULL,
  link TEXT,
  source_name TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS events_visible ON events (visible_until, starts_at);

CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  source_name TEXT NOT NULL,
  published_at TEXT,
  feed_id TEXT NOT NULL,
  title_key TEXT NOT NULL,
  neighborhood_match INTEGER NOT NULL DEFAULT 0,
  is_denverite INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS news_items_link ON news_items (link);
CREATE INDEX IF NOT EXISTS news_items_feed ON news_items (feed_id);
CREATE INDEX IF NOT EXISTS news_items_published ON news_items (published_at);

CREATE TABLE IF NOT EXISTS news_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_ok_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  item_count INTEGER NOT NULL DEFAULT 0
);
