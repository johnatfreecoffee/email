# Email — standalone client (forked from Mission Control)

A full send/receive email web app: add a domain, it auto-configures on Resend +
Cloudflare DNS, inbound mail arrives via a Resend webhook into Supabase, and a
three-panel web UI reads/sends it. **Resend-only** (no IMAP, no mailboxes).

**Live:** https://email-app-7rp.pages.dev  
**Repo:** https://github.com/johnatfreecoffee/email

This was carved out of **Mission Control** on **2026-07-08**. It still points at
the **same Supabase project** (`YOUR_PROJECT_REF`) as MC, so mail already in
`email_messages` shows up here immediately. The email module will be deleted from
Mission Control once this app is proven and the Resend webhook is re-pointed.

## Read these first

| File | What it is |
|---|---|
| **`EMAIL-SYSTEM.md`** | The brain — full architecture, every API endpoint, DB schema, deployment, services, env, gotchas. Start here. |
| **`KICKSTART.md`** | The prompt to paste into a fresh Claude chat to continue the work. |
| `docs/EMAIL-SPEC.md` | Original MC build spec (design intent; some parts predate the Resend-only cutover). |
| `.env.example` | Env template. `.env.local` (gitignored) is already filled with real keys. |

## Quick start

```bash
npm install
npm run build        # once (or after function changes) → out/
npm run dev:api      # wrangler pages dev on :8788 (loads .dev.vars)
npm run dev          # http://localhost:3000 → redirects to /email
                     # proxies /api/* → :8788 in development
```

`.env.local` has working credentials. Auth is a **shared-secret gate**:
- Server `checkAuth` accepts `X-MC-Auth === env.MC_API_SECRET` (also still
  accepts valid `mc_sessions` tokens + the legacy MC hash).
- Client auto-seeds `localStorage["mc-auth-token"]` from
  `NEXT_PUBLIC_MC_API_SECRET` (or a tiny password screen if unset).
- Local API path: **`wrangler pages dev out`** (not plain `next dev` alone —
  static Next does not run Pages Functions). `next.config.ts` rewrites `/api/*`
  to `http://127.0.0.1:8788` only when `NODE_ENV=development`.

## Stack

Next.js 16 (App Router, `output: "export"`) · React 19 · Tailwind v4 · Tiptap
editor · Supabase (Postgres + Storage) · Resend (inbound + outbound) ·
Cloudflare Pages + Pages Functions (`functions/api/email/*`) · Web Push (VAPID).

## Layout

```
functions/api/email/     15 Cloudflare Pages Functions = the backend API
src/app/email/           the /email route (three-panel client)
src/components/email/     11 UI components (list, reader, compose, editor, domains…)
src/lib/                  auth, supabase, theme, push-notifications, utils
migrations/              email-*.sql (see EMAIL-SYSTEM.md §7 for current vs legacy)
```

## What was pruned in the fork

MC's global chrome (`Sidebar`, `TopNav`, `AppChrome`, `VoiceProvider`), the
`shadcn/ui` folder, and MC's unrelated **issues/notifications** `/inbox` module
(`src/app/inbox`, `functions/api/inbox.js` — queried `mc_issues`, not email) were
removed. The email product is self-contained. See `EMAIL-SYSTEM.md §12`.
