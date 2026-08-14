-- Cloud box heartbeat, separate from This machine.

ALTER TABLE agent_runtime
  ADD COLUMN IF NOT EXISTS box_seen_at TIMESTAMPTZ;
