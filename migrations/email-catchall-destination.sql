-- Add the per-domain catch-all destination address.
-- When an inbound email arrives for an address that doesn't exist on the
-- domain (is_catch_all = true), and the domain has a catchall_destination_address_id
-- set, the message is attributed to that address — so the chosen recipient
-- sees catch-all mail in their own inbox view.
ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS catchall_destination_address_id UUID
  REFERENCES email_addresses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_domains_catchall_dest
  ON email_domains(catchall_destination_address_id)
  WHERE catchall_destination_address_id IS NOT NULL;
