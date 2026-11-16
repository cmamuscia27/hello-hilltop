-- Neighbor-hosted events wait here until an admin approves one into `events`.
-- organizer_email is never copied onto the public event row.
-- wrangler deploy does not apply this file.

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
