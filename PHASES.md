# Phases: Agent reply pipeline + 48h backfill

Source: `SPEC.md`. If it is not in the spec, it does not exist.

## Build

### P1 — Worker: honest finish + 15-min + death [x]
**Files:** `worker/worker.py`, `worker/test_sessions.py`, `worker/config.env.example`
- Raise default MAX_TURNS to 120. Patch live `~/Library/AgentMail/config.env` MAX_TURNS only
- Max-turns with no human note: auto-continue once (cap 2). Still empty → honest stuck mail, never EMPTY_DONE
- 15-min pulse after the 25s ack. Skip if newer inbound exists for that session
- Watchdog: spawn fail / empty / restart with orphan `working` → died mail + stuck
- Prompt: print zero until done; NokNok ships main before the finished email; 15-min is worker-owned
- Tests: empty stdout ≠ Done; pulse skip; finish_stage mapping

### P2 — Attachments actually readable [x]
**Files:** `functions/api/email/inbound.ts`, `worker/worker.py` materialize
- Always fetch Resend receiving attachments API (iPhone inline), not only webhook `attachments[]`
- Never persist `pending/` as the only copy
- Worker retries pending via Resend; log `files session= n= names=`
- Prompt: read each image path before answering

### P3 — One chain [x]
**Files:** `worker/worker.py` send/persist, `functions/api/email/_thread.ts`
- Sticky `rec.email_thread_id`. Patch inbound onto that thread if it minted a new one
- In-Reply-To + full References. Persist outbound onto the session thread
- Inbound: match `(ID: n)` / normalized subject / References before minting a new thread

### P4 — Mac LaunchAgent [x]
**Files:** `scripts/install-local-worker.sh`
- ProcessType=Standard; caffeinate -i wrapper; KeepAlive; drop Documents leftover script
- Reinstall. Confirm launchctl running, BTM enabled, no TCC Documents errors
- Setup / How-it-works one-liner: worker lives while Mac is awake; lid close sleeps unless Energy toggle

### P5 — How-it-works + Kanban copy [x]
**Files:** `functions/api/email/agent-how.ts`, `src/lib/agent-access.ts`, `src/components/email/settings/setup-tab.tsx`
- Replace “ack then one mail, no check-ins” with ack / 15-min / done-or-questions / died
- Stage colors unchanged (no purple)

### P6 — Ship pipeline [ ]
- Tests, commit, push main (email-app). Install worker. Confirm heartbeat

### P7 — 48h backfill [ ] (only after P6)
Must finish: 999004, 999006, 45, 46. Audit 37–44. Skip 999001–999003.
NokNok backfill = real product fix on `~/Documents/noknok.pro`, merge main, live noknok-app, then the done email.

## UI match [ ]
How-it-works + Setup copy vs existing Agents/Settings tiles. Desktop + ~390. No new chrome.

## Hunt [ ]
Send a job to `a.email` from `johnfrankromanojr@gmail.com` with a screenshot; CC `test@freecoffee.dev`. Confirm ack, attachments read, one done mail in the same thread, card Done. Kill Grok mid-job → died mail + stuck.

## Clean run
One full hunt with zero findings. Then stop.
