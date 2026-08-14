-- Shared lock so inbound cloud-chat and the local worker never double-reply.

CREATE TABLE IF NOT EXISTS agent_handled_messages (
  message_id  UUID PRIMARY KEY,
  via         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE agent_handled_messages ENABLE ROW LEVEL SECURITY;
