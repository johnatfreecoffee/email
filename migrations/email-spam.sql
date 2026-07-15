-- Spam filtering: per-message classification + per-sender reputation cache.
-- See plan: spam classifier runs at inbound webhook time. High-confidence
-- spam moves to folder='spam'. Per-sender verdicts are memoized so the
-- LLM is only consulted for unseen senders.

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS is_spam         BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS spam_score      REAL,
  ADD COLUMN IF NOT EXISTS spam_reason     TEXT,
  ADD COLUMN IF NOT EXISTS spam_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_email_messages_spam
  ON email_messages (is_spam, folder);

CREATE TABLE IF NOT EXISTS email_sender_reputation (
  from_address  TEXT PRIMARY KEY,
  verdict       TEXT NOT NULL CHECK (verdict IN ('spam', 'trusted', 'unknown')),
  spam_score    REAL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sample_count  INT         NOT NULL DEFAULT 1,
  user_override BOOLEAN     NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_sender_reputation_verdict
  ON email_sender_reputation (verdict);
