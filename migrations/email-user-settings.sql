-- Per-user email preferences (domain sidebar order, etc.).
-- Global roaming prefs stay in email_settings; user-scoped keys live here.
--
-- Canonical key:
--   'sidebar' → {"domainOrder": ["<domain uuid>", ...]}
--
-- New domains not in domainOrder append at the end in the client.

CREATE TABLE IF NOT EXISTS email_user_settings (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_email_user_settings_user
  ON email_user_settings (user_id);
