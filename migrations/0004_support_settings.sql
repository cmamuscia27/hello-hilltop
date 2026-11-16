-- Payment links for /support. Values are public https URLs (a Stripe Payment
-- Link, Venmo, Zeffy, PayPal). The page never stores card numbers. An empty
-- table means "coming soon". wrangler deploy does not apply this file.

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
