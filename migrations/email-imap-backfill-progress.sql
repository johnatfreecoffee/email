-- ============================================================
-- Email backfill: chunked progress tracking
-- ============================================================
-- imap_backfill_progress jsonb shape:
--   {
--     "processed_count": <int>,
--     "total_estimated": <int>,
--     "last_received_at": "<ISO ts>",  -- cursor: skip msgs newer than this
--     "started_at": "<ISO ts>",
--     "last_chunk_at": "<ISO ts>",
--     "errors": <int>
--   }
--
-- imap_backfill_status values:
--   NULL          → never started
--   'in_progress' → mid-backfill, more chunks pending
--   'completed'   → all messages successfully appended
--   'failed'      → terminal failure (creds wrong, etc.)
ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS imap_backfill_progress JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_email_addresses_backfill_in_progress
  ON email_addresses(imap_backfill_status)
  WHERE imap_backfill_status = 'in_progress';
