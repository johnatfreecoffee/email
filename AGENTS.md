# Email

One repo: webmail + optional coding agents.

## Layout

- `src/` + `functions/api/email/` — browser + Cloudflare Pages API
- `worker/` — local (or Docker) process that turns `a.*` / `e.*` mail into Grok jobs
- `scripts/install-local-worker.sh` — copies the worker to `~/Library/AgentMail` (Mac data dir, not a project)
- `migrations/` — paste in Supabase

## Do not

- Revive `~/Documents/AgentMail` — retired. This folder is the project.
- Point the LaunchAgent at Documents (macOS TCC blocks it).
- Commit `config.env` / `.env.local` / `.dev.vars`.

## Agents

- Create mailboxes in Settings → Agents. Worker loads them from Supabase each poll.
- Optional folder map: `~/Library/AgentMail/workspaces.json`
- Allowlist: `agent_senders` / `agent_sender_grants`
- Unknown / archived / agent off → no Grok

## Ship

- UI/API: commit + push `main` → CF Pages `email-app`
- Worker: edit `worker/*.py`, then `./scripts/install-local-worker.sh`
