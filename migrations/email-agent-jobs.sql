-- Agent Kanban. One row per agent session. Service role only (RLS on, no anon policies).

CREATE TABLE IF NOT EXISTS agent_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           INTEGER NOT NULL,
  agent_local          TEXT NOT NULL,
  mailbox              TEXT,
  base_subject         TEXT NOT NULL DEFAULT '',
  stage                TEXT NOT NULL DEFAULT 'received'
                         CHECK (stage IN ('received', 'working', 'waiting', 'done', 'stuck')),
  email_thread_id      TEXT,
  last_message_id      UUID,
  used_k               INTEGER NOT NULL DEFAULT 1,
  used_tokens          INTEGER NOT NULL DEFAULT 0,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  last_reply_at        TIMESTAMPTZ,
  done_at              TIMESTAMPTZ,
  stuck_at             TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                TEXT NOT NULL DEFAULT '',
  remind_requested_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_session_agent
  ON agent_jobs (session_id, agent_local);

CREATE INDEX IF NOT EXISTS agent_jobs_agent_local_idx
  ON agent_jobs (agent_local);

CREATE INDEX IF NOT EXISTS agent_jobs_stage_idx
  ON agent_jobs (stage);

CREATE INDEX IF NOT EXISTS agent_jobs_updated_at_idx
  ON agent_jobs (updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_job_events (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id   UUID NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('received', 'working', 'waiting', 'done', 'stuck', 'reply', 'note', 'remind')),
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail   TEXT
);

CREATE INDEX IF NOT EXISTS agent_job_events_job_at_idx
  ON agent_job_events (job_id, at);

ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_job_events ENABLE ROW LEVEL SECURITY;
