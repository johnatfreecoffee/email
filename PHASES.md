# Phases: Agent Kanban + done + parallel sessions

Source: `SPEC.md`. If it is not in the spec, it does not exist.

## Build

### P1 — Worker: parallel sessions, context tag, done signaling [x]
**Files:** `worker/worker.py` (+ tests under `worker/`). Do not add UI.
**Ship:** edit worker, `./scripts/install-local-worker.sh`
- New subject (no `(ID: n)`, different `base_subject`) = **new session**. Do not reuse by `email_thread_id` alone if the base subject differs.
- Same `(ID: n)` or `Re:` of the same base subject + same agent = same session.
- Several sessions run **in parallel** in one worker process. One long Grok job must not block other new-subject mails. Same session stays serial.
- Subject tag `{usedK}/500K` is **this session only**. New session starts small. Never paint 500/500K unless this session actually burned ~500K. Do not treat model-window / `total_tokens` as used. Fix the wall-clock estimate (`wall * 2500` is per-second and caps in minutes).
- Finished reply **states this turn is done**. Ban the vague fallback “I looked at this — write back if you want me to go deeper on any piece.” Timeout / empty-stdout copy must say what finished vs what did not.
- Keep: Hey First, 30k-foot, closer + agent name, ack ~25s then one finished mail, no thinking dumps.

### P2 — Kanban schema + API [x]
**Files:** `migrations/email-agent-jobs.sql`, `functions/api/email/agent-jobs.ts`. No UI. No `worker.py`.
- Table `agent_jobs`: one row per agent session. Stages: `received | working | waiting | done | stuck`.
- Columns: session_id, agent_local, mailbox, base_subject, stage, email_thread_id, last_message_id, used_k, used_tokens, received_at, started_at, last_reply_at, done_at, stuck_at, updated_at, notes, remind_requested_at.
- Table `agent_job_events`: timestamped log (received, working, waiting, done, stuck, reply, note, remind).
- API `GET/PATCH /api/email/agent-jobs` (list + filters `agent`, `stage`; single by id; patch notes; POST remind sets `remind_requested_at`).
- Apply the SQL to live Supabase (project `sxjtpprtaascxafddddg`). Do not ask John to paste.

### P3 — Worker board writes + remind + agent knows the board [x]
**Files:** `worker/worker.py`, prompt text. After P1+P2.
- Upsert `agent_jobs` + events: inbound → received; grok start → working; finished reply → done; clarifying question only → waiting; timeout / no progress → stuck.
- Prompt: the Kanban exists; agent may append a short note for the card; when the turn is done, say so.
- Remind: if `remind_requested_at` is set, nudge that session (same ID), then clear the flag.
- `./scripts/install-local-worker.sh`

### P4 — Kanban UI in the mail app [x]
**Files:** `src/components/email/*`, `src/app/email/page.tsx` only as needed. After P2.
- Board inside this app (sidebar entry next to Agents). Not a new product.
- Columns = stages. Filters = agent mailbox + stage.
- Card: subject, agent, stage, usedK/500K, last activity time.
- Click card → thread + timestamps + notes. Remind button on stuck/waiting.
- Apple Mail chrome. No purple. Empty/loading/error states.

## UI match [x]
Diff every new/changed screen vs existing Agents sidebar + Settings cards. Desktop + ~390 mobile. No new color language.

## Hunt [x]
Console, network, frontend, backend, channels (test@freecoffee.dev if a mail send is in scope), broken-path. Identities: `johnfrankromanojr@gmail.com` / Voice 504-535-4551 / `test@freecoffee.dev`.

## Clean run
One full hunt with zero findings. Then stop.
