-- Single-row cache + progress state for the live Suggested Mailshots sync
-- (see src/shared/mailshotSourcing.js, mailshotMatching.js and
-- src/routes/mailshot-sync.js). Kept separate from portal_state for the
-- same reason leadforensics_cache is: that table's save path replaces the
-- whole JSON blob on every ordinary call-note/lead edit, so anything put
-- inside it would get silently wiped.
--
-- The `data` blob holds: per-mailbox Sent Items pagination cursors and
-- progress (so a large mailbox's history is scanned across several runs,
-- not all at once - the same Cloudflare 50-subrequest-per-invocation
-- constraint that broke the first Lead Forensics run applies here too),
-- the discovered-but-not-yet-verified domains, and the final verified
-- candidates (replacing MAILSHOT_MATCHED) plus the live Salesforce
-- block-list (replacing SALESFORCE_BLOCKED).
CREATE TABLE IF NOT EXISTS mailshot_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
