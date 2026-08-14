-- Agent Mail allowlist. Worker hard-blocks before Grok using these rows.
-- Service role only (RLS on, no anon policies).

CREATE TABLE IF NOT EXISTS agent_senders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  email       TEXT NOT NULL,
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_senders_email_lower
  ON agent_senders (lower(email));

CREATE TABLE IF NOT EXISTS agent_sender_grants (
  sender_id    UUID NOT NULL REFERENCES agent_senders(id) ON DELETE CASCADE,
  agent_local  TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  mode         TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('ask', 'custom', 'all')),
  perms        JSONB NOT NULL DEFAULT '{"read":true,"write":false,"update":false,"delete":false}'::jsonb,
  PRIMARY KEY (sender_id, agent_local)
);

CREATE TABLE IF NOT EXISTS agent_runtime (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hands           TEXT NOT NULL DEFAULT 'local',
  worker_seen_at  TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO agent_runtime (id, hands) VALUES (1, 'local')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE agent_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sender_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime ENABLE ROW LEVEL SECURITY;
