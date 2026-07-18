-- ============================================================
-- Delivery rules: evaluated in inbound.ts after spam
-- classification, in priority order (0 = top). All matching
-- rules apply; later rules win on conflicting actions.
--
-- conditions: [{"field":"from|to|subject","op":"contains|equals|ends_with","value":"…"}]
-- actions:    [{"type":"move_folder|mark_read|flag|junk|trash","folder":"inbox|archive"?}]
-- domain_id NULL = applies to all domains.
-- ============================================================

CREATE TABLE IF NOT EXISTS email_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  priority INT NOT NULL DEFAULT 0,
  match_type TEXT NOT NULL DEFAULT 'all' CHECK (match_type IN ('all','any')),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  domain_id UUID REFERENCES email_domains(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_rules_active ON email_rules (is_active, priority);
