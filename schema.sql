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
