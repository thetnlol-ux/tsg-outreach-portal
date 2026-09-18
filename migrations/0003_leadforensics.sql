-- Single-row cache of the Lead Forensics domain-match sync (see
-- src/shared/leadForensics.js and src/routes/leadforensics-sync.js).
-- Kept separate from portal_state deliberately: that table's save path
-- (src/state.js) replaces the whole JSON blob on every save, so anything
-- put inside it would get silently wiped by the next ordinary call-note
-- or lead edit unless every save path remembered to carry it forward.
CREATE TABLE IF NOT EXISTS leadforensics_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
