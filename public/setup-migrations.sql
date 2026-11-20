-- =====================================================================
-- Plug-and-Play All-in-One Supabase Schema
-- Paste this entire file once into Supabase -> SQL Editor -> Run.
-- Safe to re-run (fully idempotent: IF NOT EXISTS everywhere).
-- =====================================================================

-- 1. Core Email Domains
CREATE TABLE IF NOT EXISTS email_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL UNIQUE,
  resend_domain_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  dns_records JSONB,
  cloudflare_zone_id TEXT,
  capabilities JSONB DEFAULT '{"sending": true, "receiving": true}'::jsonb,
  catch_all_enabled BOOLEAN NOT NULL DEFAULT false,
  catch_all_subject_prefix TEXT NOT NULL DEFAULT '[Catch-All]',
  receive_only BOOLEAN NOT NULL DEFAULT false,
  display_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Email Addresses (per-domain mailboxes)
CREATE TABLE IF NOT EXISTS email_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES email_domains(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  display_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_mailbox BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_addresses_unique
  ON email_addresses(domain_id, address);

-- Optional per-domain catch-all destination
ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS catchall_destination_address_id UUID
  REFERENCES email_addresses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_domains_catchall_dest
  ON email_domains(catchall_destination_address_id)
  WHERE catchall_destination_address_id IS NOT NULL;

-- 3. Email Messages
CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID REFERENCES email_domains(id),
  address_id UUID REFERENCES email_addresses(id),
  resend_email_id TEXT,
  ingest_message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses JSONB DEFAULT '[]'::jsonb,
  bcc_addresses JSONB DEFAULT '[]'::jsonb,
  reply_to TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  headers JSONB,
  in_reply_to TEXT,
  thread_id UUID,
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_starred BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  is_trash BOOLEAN NOT NULL DEFAULT false,
  is_draft BOOLEAN NOT NULL DEFAULT false,
  is_catch_all BOOLEAN NOT NULL DEFAULT false,
  is_spam BOOLEAN NOT NULL DEFAULT false,
  spam_score REAL,
  spam_reason TEXT,
  spam_checked_at TIMESTAMPTZ,
  folder TEXT NOT NULL DEFAULT 'inbox',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_domain ON email_messages(domain_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_address ON email_messages(address_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_folder ON email_messages(folder, is_trash, is_archived);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_received ON email_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_spam ON email_messages(is_spam, folder);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_ingest_dedup
  ON email_messages(domain_id, ingest_message_id)
  WHERE ingest_message_id IS NOT NULL;

-- 4. Email Attachments
CREATE TABLE IF NOT EXISTS email_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  storage_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_attachments_message ON email_attachments(message_id);

-- 5. Roaming Settings + Plug-and-Play Integration Keys
CREATE TABLE IF NOT EXISTS email_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_user_settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_email_user_settings_user ON email_user_settings(user_id);

-- 6. Delivery Rules
CREATE TABLE IF NOT EXISTS email_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INT NOT NULL DEFAULT 0,
  match_type TEXT NOT NULL DEFAULT 'all' CHECK (match_type IN ('all', 'any')),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  domain_id UUID REFERENCES email_domains(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_rules_active ON email_rules(is_active, priority);

-- 7. Sender Reputation / Spam Cache
CREATE TABLE IF NOT EXISTS email_sender_reputation (
  from_address TEXT PRIMARY KEY,
  verdict TEXT NOT NULL CHECK (verdict IN ('spam', 'trusted', 'unknown')),
  spam_score REAL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sample_count INT NOT NULL DEFAULT 1,
  user_override BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_sender_reputation_verdict ON email_sender_reputation(verdict);

-- 8. Web Push Subscriptions
CREATE TABLE IF NOT EXISTS mc_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL UNIQUE,
  subscription_json JSONB NOT NULL,
  label TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. Agent Mail Tables (Allowlist, Grants, Runtime Heartbeat, Kanban Jobs)
CREATE TABLE IF NOT EXISTS agent_handled_messages (
  message_id UUID PRIMARY KEY,
  via TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_senders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_senders_email_lower
  ON agent_senders (lower(email));

CREATE TABLE IF NOT EXISTS agent_sender_grants (
  sender_id UUID NOT NULL REFERENCES agent_senders(id) ON DELETE CASCADE,
  agent_local TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mode TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('ask', 'custom', 'all')),
  perms JSONB NOT NULL DEFAULT '{"read":true,"write":false,"update":false,"delete":false}'::jsonb,
  PRIMARY KEY (sender_id, agent_local)
);

CREATE TABLE IF NOT EXISTS agent_runtime (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hands TEXT NOT NULL DEFAULT 'local',
  worker_seen_at TIMESTAMPTZ,
  box_seen_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO agent_runtime (id, hands) VALUES (1, 'local')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id INT NOT NULL,
  agent_local TEXT NOT NULL,
  mailbox TEXT,
  base_subject TEXT NOT NULL DEFAULT '(no subject)',
  stage TEXT NOT NULL CHECK (stage IN ('received', 'working', 'waiting', 'done', 'stuck')),
  email_thread_id TEXT,
  last_message_id UUID,
  used_k INT NOT NULL DEFAULT 1,
  used_tokens INT NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  last_reply_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  stuck_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT NOT NULL DEFAULT '',
  remind_requested_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_agent_local_session
  ON agent_jobs (agent_local, session_id);
CREATE INDEX IF NOT EXISTS agent_jobs_stage ON agent_jobs(stage);
CREATE INDEX IF NOT EXISTS agent_jobs_updated_at ON agent_jobs(updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('received', 'working', 'waiting', 'done', 'stuck', 'reply', 'note', 'remind')),
  detail TEXT
);

CREATE INDEX IF NOT EXISTS agent_job_events_job_id_at ON agent_job_events(job_id, at);

ALTER TABLE agent_handled_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sender_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_job_events ENABLE ROW LEVEL SECURITY;

-- 10. Private Attachment Storage Bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('email-attachments', 'email-attachments', false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
