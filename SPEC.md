# Spec: Agent reply pipeline + 48h backfill

## Done

Last 48 hours of agent mail: attachments readable, work actually finished, NokNok jobs shipped to main, one honest finished mail per chain (or one waiting question).

New mail always gets: got-it ack (~25s) → every 15 min “still working” until finish → done mail (what shipped / questions) or died mail. Never `EMPTY_DONE`. Never thinking dumps.

John’s replies stay in the same app/Gmail chain and the same Kanban card.

Mac worker stays up while the Mac is awake; lid-close / process death is honest; one-time Settings listed if anything is still gated.

## Not doing

- A new product, second app, Fly box, or cloud-only worker rewrite
- Rewriting inbox, compose, settings chrome, or allowlist
- Changing the human voice (`Hey {First},` 30k-foot, closer + agent name)
- Re-running Hunt test sessions 999001–999003
- Dual Mac+HP workers in this factory

## Accept

**Replies (HARD)**
- Ack ~25s if still running
- Every 15 minutes if not done: short “still on {topic}, still working.” Skip the pulse if John already emailed back on that session
- Finished mail is only: (a) this turn is done + what shipped, or (b) one waiting question. No play-by-play
- Max-turns / empty stdout / crash / timeout: do not mail `EMPTY_DONE`. Do not mark Done. Honest mail + stage `stuck`, or auto-continue one more Grok turn (cap 2). Then tell the truth if it still died
- If John replies while a job is running: no more 15-min pulses; after the current Grok exits, pick up the new mail on the same session

**Attachments (HARD)**
- Inbound files (including iPhone inline images) stored for real, not `pending/`
- Worker downloads onto disk and the prompt lists absolute paths
- Grok must read images/PDFs before answering. Empty inbound-files on a mail that had screenshots = fail

**Threads (HARD)**
- One session = one `email_thread_id` (sticky from first inbound). Outbound persist uses that, not a newly minted inbound thread
- `In-Reply-To` + full `References` chain so Gmail/iPhone stay in one thread
- Kanban card shows John’s mails and agent mails together

**Ship (HARD)**
- NokNok (`a.noknok`) finished mail only after the change is on main / live `noknok-app`. Same for other project agents when the ask was fix/ship
- Email UI/API: push main → CF Pages `email-app`. Worker: `./scripts/install-local-worker.sh` (do not overwrite `config.env`)

**Mac stay-alive**
- LaunchAgent: KeepAlive, RunAtLoad, ProcessType=Standard (not Background), wrap with `caffeinate -i`
- Delete leftover `run-agent-mail.sh` Documents path
- On worker start: any Kanban `working` with no live Grok = died mail + `stuck`
- Lid closed: Mac sleeps. One human toggle: System Settings → Energy → Prevent automatic sleeping on power adapter when the display is off. Background Items already lists Agent Mail

**Kanban**
- Empty/canned/max-turns ≠ Done. `waiting` only when the mailed body is a real question. `stuck` on died/timeout/empty. Remind still same session

## Keep

- One repo: `~/Documents/email`. Worker: `worker/` → `./scripts/install-local-worker.sh` → `~/Library/AgentMail`
- Agent mail stays in `folder=agent`; hidden from inbox
- Settings → Agents (Users / Access / Mailboxes / How it works)
- Worker deny-by-default (unknown / archived / agent off → no Grok)
- Existing mail UX, threading, compose, settings
- Apple Mail chrome. No purple / violet / indigo / fuchsia
