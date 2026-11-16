-- Hello! Hilltop D1 schema (database: hello-hilltop-db)
CREATE TABLE IF NOT EXISTS signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC
  name TEXT,
  email TEXT NOT NULL UNIQUE,
  volunteer INTEGER NOT NULL DEFAULT 0,
  source TEXT
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC
  name TEXT,
  email TEXT,
  idea TEXT NOT NULL,
  would_help INTEGER NOT NULL DEFAULT 0
);

-- Neighborhood events and the cached news strip. Same statements as
-- migrations/0001_hood.sql. An existing database should use
-- `wrangler d1 migrations apply` rather than re-running this file.
-- Event clocks are America/Denver in starts_local / ends_local.
-- starts_at, ends_at, and visible_until are UTC instants.

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
  icon TEXT,
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

-- Cached Instagram posts. Same statements as migrations/0003_instagram.sql.
-- token_cipher is an encrypted access token. Nothing in the API returns it.

CREATE TABLE IF NOT EXISTS instagram_posts (
  id TEXT PRIMARY KEY,
  permalink TEXT NOT NULL,
  media_type TEXT,
  image_url TEXT,
  caption TEXT,
  posted_at TEXT,
  source TEXT NOT NULL,
  position INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instagram_pins (
  position INTEGER PRIMARY KEY CHECK (position >= 0 AND position < 6),
  url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instagram_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_cipher TEXT,
  token_stored_at TEXT,
  token_expires_at TEXT,
  last_ok_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  mode TEXT
);

-- Payment links, the neighbor directory, hosted-event proposals, and curated
-- notes. Same statements as migrations 0004 through 0007. An existing
-- database should use `wrangler d1 migrations apply` rather than re-running
-- this file. Deploy does not apply migrations.

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS directory_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  contact TEXT NOT NULL,
  contact_url TEXT,
  submitter_name TEXT,
  submitter_email TEXT NOT NULL,
  consent INTEGER NOT NULL CHECK (consent = 1),
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS directory_public ON directory_listings (status, category);
CREATE INDEX IF NOT EXISTS directory_email_recent ON directory_listings (submitter_email, created_at);

CREATE TABLE IF NOT EXISTS directory_removals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  listing_id INTEGER,
  listing_title TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done'))
);

CREATE INDEX IF NOT EXISTS directory_removals_status ON directory_removals (status, id);

CREATE TABLE IF NOT EXISTS event_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  title TEXT NOT NULL,
  starts_local TEXT NOT NULL,
  ends_local TEXT,
  location TEXT NOT NULL,
  description TEXT NOT NULL,
  link TEXT,
  organizer_name TEXT NOT NULL,
  organizer_email TEXT NOT NULL,
  kid_friendly INTEGER NOT NULL DEFAULT 0,
  dog_friendly INTEGER NOT NULL DEFAULT 0,
  event_id INTEGER,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS event_proposals_status ON event_proposals (status, id);
CREATE INDEX IF NOT EXISTS event_proposals_email_recent ON event_proposals (organizer_email, created_at);

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
