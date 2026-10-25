-- Receive-only domains (Cloudflare Email Routing / custom ingest — no Resend domain)

ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS receive_only BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS display_label TEXT;

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS ingest_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_ingest_dedup
  ON email_messages (domain_id, ingest_message_id)
  WHERE ingest_message_id IS NOT NULL;

-- myphone.solutions: INC inbox only (CF Email Routing → ingest API)
INSERT INTO email_domains (
  domain,
  resend_domain_id,
  status,
  capabilities,
  catch_all_enabled,
  catch_all_subject_prefix,
  receive_only,
  display_label,
  cloudflare_zone_id
)
VALUES (
  'myphone.solutions',
  NULL,
  'active',
  '{"sending": false, "receiving": true}'::jsonb,
  true,
  '[Catch-All]',
  true,
  '(INC only) myphone.solutions',
  'ae7d255758840a35384828023ee25e96'
)
ON CONFLICT (domain) DO UPDATE SET
  receive_only = EXCLUDED.receive_only,
  display_label = EXCLUDED.display_label,
  catch_all_enabled = EXCLUDED.catch_all_enabled,
  status = EXCLUDED.status,
  capabilities = EXCLUDED.capabilities,
  cloudflare_zone_id = EXCLUDED.cloudflare_zone_id,
  updated_at = now();

INSERT INTO email_addresses (domain_id, address, display_name, is_active)
SELECT d.id, 'hello', 'hello@myphone.solutions', true
FROM email_domains d
WHERE d.domain = 'myphone.solutions'
ON CONFLICT (domain_id, address) DO UPDATE SET
  is_active = true,
  display_name = EXCLUDED.display_name;
