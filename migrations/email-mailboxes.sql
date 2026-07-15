-- ============================================================
-- Mission Control: Email — Migadu mailbox provisioning
-- ============================================================
-- Adds tracking for which email_addresses rows are real IMAP/SMTP
-- mailboxes provisioned via Migadu's admin API (vs. plain aliases
-- used only for sending from the MC web UI).

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS is_mailbox BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS migadu_provisioned_at TIMESTAMPTZ;

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS mc_user_id UUID REFERENCES mc_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_addresses_mc_user
  ON email_addresses(mc_user_id) WHERE mc_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_addresses_mailbox
  ON email_addresses(is_mailbox, is_active) WHERE is_mailbox = true;
