-- Neighbor Directory. Public pages only read status = 'approved'.
-- submitter_email is for the organizers and removal requests. It is not rendered.
-- wrangler deploy does not apply this file.

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
