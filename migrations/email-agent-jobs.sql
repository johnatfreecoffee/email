-- Agent Kanban: one row per agent session, plus a timestamped event log.
-- Service role only (RLS on, no anon policies).
-- Idempotent: CREATE IF NOT EXISTS plus ALTERs so a weaker existing table
-- is brought in line with the spec (session_id int, last_message_id uuid,
-- NOT NULL defaults).

CREATE TABLE IF NOT EXISTS agent_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           INT NOT NULL,
  agent_local          TEXT NOT NULL,
  mailbox              TEXT,
  base_subject         TEXT NOT NULL,
  stage                TEXT NOT NULL CHECK (stage IN ('received', 'working', 'waiting', 'done', 'stuck')),
  email_thread_id      TEXT,
  last_message_id      UUID,
  used_k               INT NOT NULL DEFAULT 1,
  used_tokens          INT NOT NULL DEFAULT 0,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  last_reply_at        TIMESTAMPTZ,
  done_at              TIMESTAMPTZ,
  stuck_at             TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                TEXT NOT NULL DEFAULT '',
  remind_requested_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_agent_local_session
  ON agent_jobs (agent_local, session_id);

CREATE INDEX IF NOT EXISTS agent_jobs_stage
  ON agent_jobs (stage);

CREATE INDEX IF NOT EXISTS agent_jobs_updated_at
  ON agent_jobs (updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_job_events (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id   UUID NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind     TEXT NOT NULL CHECK (kind IN ('received', 'working', 'waiting', 'done', 'stuck', 'reply', 'note', 'remind')),
  detail   TEXT
);

CREATE INDEX IF NOT EXISTS agent_job_events_job_id_at
  ON agent_job_events (job_id, at);

-- Align a pre-existing weaker table (CREATE IF NOT EXISTS is a no-op then).
UPDATE agent_jobs SET base_subject = '(no subject)' WHERE base_subject IS NULL OR btrim(base_subject) = '';
UPDATE agent_jobs SET notes = COALESCE(notes, '') WHERE notes IS NULL;
UPDATE agent_jobs SET received_at = COALESCE(received_at, updated_at, now()) WHERE received_at IS NULL;

ALTER TABLE agent_jobs
  ALTER COLUMN session_id TYPE INT USING session_id::int,
  ALTER COLUMN last_message_id TYPE UUID USING NULLIF(btrim(last_message_id::text), '')::uuid,
  ALTER COLUMN base_subject SET NOT NULL,
  ALTER COLUMN received_at SET DEFAULT now(),
  ALTER COLUMN received_at SET NOT NULL,
  ALTER COLUMN notes SET DEFAULT '',
  ALTER COLUMN notes SET NOT NULL,
  ALTER COLUMN used_k SET DEFAULT 1,
  ALTER COLUMN used_tokens SET DEFAULT 0,
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_jobs_stage_check' AND conrelid = 'public.agent_jobs'::regclass
  ) THEN
    ALTER TABLE agent_jobs
      ADD CONSTRAINT agent_jobs_stage_check
      CHECK (stage IN ('received', 'working', 'waiting', 'done', 'stuck'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_job_events_kind_check' AND conrelid = 'public.agent_job_events'::regclass
  ) THEN
    ALTER TABLE agent_job_events
      ADD CONSTRAINT agent_job_events_kind_check
      CHECK (kind IN ('received', 'working', 'waiting', 'done', 'stuck', 'reply', 'note', 'remind'));
  END IF;
END $$;

ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_job_events ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
