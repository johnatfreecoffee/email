-- ============================================================
-- Mission Control: Email — encrypted IMAP credentials
-- ============================================================
-- Stores per-mailbox IMAP password (encrypted with AES-GCM using a key
-- held in Cloudflare Pages env, NOT in the database). Required so MC's
-- backend can perform IMAP operations on behalf of users:
--   - Backfill historical Supabase mail into Migadu on first signin
--   - Append MC-composed messages to Migadu Sent folder so clients see them
--   - Poll Migadu for client-sent mail and read-state changes
--
-- Format of imap_credential_encrypted:
--   { "iv": "<base64>", "ct": "<base64>", "alg": "AES-GCM", "v": 1 }
-- The plaintext is the user's IMAP password — same one they use in Apple Mail.

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS imap_credential_encrypted JSONB;

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS imap_backfill_status TEXT;
-- statuses: NULL (not started), 'in_progress', 'completed', 'failed'

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS imap_backfill_at TIMESTAMPTZ;

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS imap_last_polled_at TIMESTAMPTZ;
-- For the polling cron: skip mailboxes polled within the last N minutes.
