-- One row per person who has ever signed in - needed so
-- salesforce_connections/outlook_connections have something stable to key
-- on. This portal has no company/tenant isolation (see README), so unlike
-- tsg-portal's `users` table there is no company_id here.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ms_oid TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

-- One Salesforce login per person, per their own org (Tapflo and Sychem
-- are separate Salesforce orgs, resolved from the person's email domain -
-- see src/shared/salesforceOrgs.js).
CREATE TABLE IF NOT EXISTS salesforce_connections (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  org_key TEXT NOT NULL,
  instance_url TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT NOT NULL,
  salesforce_user_id TEXT,
  salesforce_email TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One Outlook mailbox connection per person, via the same Entra app used
-- for sign-in (wider scopes, its own redirect address).
CREATE TABLE IF NOT EXISTS outlook_connections (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  refresh_token TEXT NOT NULL,
  access_token TEXT NOT NULL,
  ms_user_id TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
