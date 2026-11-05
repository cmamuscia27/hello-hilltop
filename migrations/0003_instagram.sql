-- Cached Instagram posts for the homepage.
-- Page views read this table. A cron refresh (and the admin refresh endpoint)
-- fills it from the official Instagram API, or from official oEmbed for a
-- short list of pinned public post URLs. token_cipher is the current
-- long-lived access token encrypted with INSTAGRAM_ACCESS_TOKEN. It is never
-- returned by the API.

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
