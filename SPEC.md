# Spec: Agent Kanban + done signaling + parallel sessions

## Done

John can send several agent emails in a row (new subject = new session) and they run in parallel without freezing.

Each agent email chain is a Kanban card in the mail app. He opens the app, not the inbox, to see status.

A finished agent reply says the work is done. He does not have to write “are you done?”. If more work is possible, the agent still says it is done for this turn, then offers to go deeper.

The subject context tag shows **this session’s** used tokens vs the 500K window (`usedK/500K`). It is not stuck at `500/500K` on every reply.

## Not doing

- A new product or a second app
- Rewriting inbox, compose, settings, or non-agent mail
- Full project management (sprints, story points, multi-human assignees, estimates)
- Changing allowlist / Access / agent create-archive
- Changing the human reply voice (`Hey {First},` 30k-foot, closer + agent name, no thinking dumps)
- Cloud-only worker rewrite; local worker stays the runner

## Accept

**Parallel sessions**
- New email subject (no existing `(ID: n)`) = new session
- Reply in the same thread / same `(ID: n)` = same session
- Several sessions can run at once; one long job does not block the others

**Done signaling**
- When the job is finished, the mailed reply is the finished human reply and states that this turn is done
- Vague “I looked / write back if you want deeper” without a done line is a fail
- Long jobs still: got-it ack ~25s, then one finished reply — no mid-job check-ins

**Context tag**
- Reply subject: `Re: {base} (ID: {n} - {usedK}/500K)`
- `{usedK}` is cumulative tokens **for that session only**, from this session’s history + this turn
- A brand-new subject starts at a small usedK, not 500
- Cross-session bleed is a fail

**Kanban (inside the mail app)**
- One card per agent session / email chain
- Columns: **Received** (mail landed / queued) → **Working** (agent running) → **Waiting** (agent asked John something) → **Done** (finished reply sent) ; **Stuck** when no progress past a timeout
- Filters: agent mailbox + stage
- Click a card: open the thread (messages + timestamps + agent notes)
- Timestamps on: opened/received, agent started, each status change, each agent reply
- Agent can write notes onto the card; prompt tells the agent the board exists
- **Remind** on a stuck/waiting card nudges that session (same session, not a new one)

**Look**
- Same Apple Mail chrome as the rest of this app (sidebar, type, chips, empty states)
- No purple / violet / indigo / fuchsia. Grok = blue pill

## Keep

- One repo: `~/Documents/email`. Worker: `worker/` → `./scripts/install-local-worker.sh` → `~/Library/AgentMail`
- Agent mail stays in `folder=agent`; hidden from inbox
- Settings → Agents (Users / Access / Mailboxes / How it works)
- Worker deny-by-default (unknown / archived / agent off → no Grok)
- Deploy: commit + push `main` → CF Pages `email-app`; worker install after `worker/*.py` edits
- Existing mail UX, threading, compose, settings
