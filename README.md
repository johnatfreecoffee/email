# Email — standalone client (forked from Mission Control)

A full send/receive email web app: add a domain, it auto-configures on Resend +
Cloudflare DNS, inbound mail arrives via a Resend webhook into Supabase, and a
three-panel web UI reads/sends it. **Resend-only** (no IMAP). Optional coding
agents (`a.*` mailboxes) run from a worker in this same repo.

Clone this repo only. There is no separate Agent Mail project.

Self-hosted, one deploy per person. Point it at **your** Supabase project and
Resend account — never reuse someone else's.

Clone-and-run: **`docs/OSS-README.md`**.

## Read these first

| File | What it is |
|---|---|
| **`EMAIL-SYSTEM.md`** | The brain — full architecture, every API endpoint, DB schema, deployment, services, env, gotchas. Start here. |
| **`docs/OSS-README.md`** | Clone-and-run (mail + optional agents). |
| **`KICKSTART.md`** | The prompt to paste into a fresh Claude chat to continue the work. |
| `docs/EMAIL-SPEC.md` | Original MC build spec (design intent; some parts predate the Resend-only cutover). |
| `.env.example` | Env template. Copy to `.env.local` (gitignored) and fill your own keys. |

## Quick start

```bash
npm install
npm run build        # once (or after function changes) → out/
npm run dev:api      # wrangler pages dev on :8788 (loads .dev.vars)
npm run dev          # http://localhost:3000 → redirects to /email
                     # proxies /api/* → :8788 in development
```

Copy `.env.example` → `.env.local` and fill your keys. Auth is a **shared-secret gate**:
- Server `checkAuth` accepts `X-MC-Auth === env.MC_API_SECRET` (also accepts
  valid `mc_sessions` tokens if you use that table).
- After login, the client sends `NEXT_PUBLIC_MC_API_SECRET` as `X-MC-Auth`.
- Local API path: **`wrangler pages dev out`** (not plain `next dev` alone —
  static Next does not run Pages Functions). `next.config.ts` rewrites `/api/*`
  to `http://127.0.0.1:8788` only when `NODE_ENV=development`.

## Stack

Next.js 16 (App Router, `output: "export"`) · React 19 · Tailwind v4 · Tiptap
editor · Supabase (Postgres + Storage) · Resend (inbound + outbound) ·
Cloudflare Pages + Pages Functions (`functions/api/email/*`) · Web Push (VAPID).

## Layout

```
functions/api/email/     Cloudflare Pages Functions = the backend API
src/app/email/           the /email route (three-panel client)
src/components/email/    UI (list, reader, compose, Settings → Agents)
src/lib/                 auth, supabase, theme, push, agent helpers
worker/                  local/Docker agent worker (install script copies it out)
scripts/                 install-local-worker.sh / linux
migrations/              email-*.sql (see EMAIL-SYSTEM.md §7)
```

## What was pruned in the fork

MC's global chrome (`Sidebar`, `TopNav`, `AppChrome`, `VoiceProvider`), the
`shadcn/ui` folder, and MC's unrelated **issues/notifications** `/inbox` module
(`src/app/inbox`, `functions/api/inbox.js` — queried `mc_issues`, not email) were
removed. The email product is self-contained. See `EMAIL-SYSTEM.md §12`.
