-- ============================================================
-- Mission Control: Email Module — Database Migration
-- ============================================================

-- 1. Email Domains
CREATE TABLE IF NOT EXISTS email_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL UNIQUE,
  resend_domain_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  -- statuses: pending, dns_configured, verifying, verified, active, failed
  dns_records JSONB,
  cloudflare_zone_id TEXT,
  capabilities JSONB DEFAULT '{"sending": true, "receiving": true}'::jsonb,
  catch_all_enabled BOOLEAN NOT NULL DEFAULT false,
  catch_all_subject_prefix TEXT NOT NULL DEFAULT '[Catch-All]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Email Addresses (per-domain mailboxes)
CREATE TABLE IF NOT EXISTS email_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES email_domains(id) ON DELETE CASCADE,
  address TEXT NOT NULL,        -- local part only: "john", "brandon", "support"
  display_name TEXT,            -- friendly name: "John Romano"
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_addresses_unique
  ON email_addresses(domain_id, address);

-- 3. Email Messages
CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID REFERENCES email_domains(id),
  address_id UUID REFERENCES email_addresses(id),
  resend_email_id TEXT,
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
  -- Threading
  in_reply_to TEXT,
  thread_id UUID,
  -- Status flags
  is_read BOOLEAN NOT NULL DEFAULT false,
  is_starred BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  is_trash BOOLEAN NOT NULL DEFAULT false,
  is_draft BOOLEAN NOT NULL DEFAULT false,
  is_catch_all BOOLEAN NOT NULL DEFAULT false,
  -- Folder
  folder TEXT NOT NULL DEFAULT 'inbox',
  -- Timestamps
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_domain ON email_messages(domain_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_address ON email_messages(address_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_folder ON email_messages(folder, is_trash, is_archived);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_received ON email_messages(received_at DESC);

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

-- 5. Create storage bucket for attachments (run in Supabase dashboard or via API)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('email-attachments', 'email-attachments', false);
