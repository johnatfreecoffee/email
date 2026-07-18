# Email app — project memory

**Code:** `EM` (standalone email client forked from Mission Control / `MT`)
**Path:** `/Users/johnromano/Documents/email`
**Forked:** 2026-07-08 from `~/Projects/mission-control`
**Status:** Live on Cloudflare Pages. Do not delete email from MC until this is proven.
**2026-07-18:** Apple Mail revamp shipped — light/dark (System default), Apple-blue tokens, stacked desktop preview rows, keyset-cursor infinite scroll (envelope API), instant unread counts (catch-all bucket fixed), Favorites v2 (pin any mailbox + drag reorder).
**2026-07-18 (phase 2):** Apple-style Settings window (accounts/junk/viewing/composing/signatures/rules/privacy), server-synced prefs (`email_settings` — **migration SQL must be pasted in Supabase dashboard**, app degrades gracefully until then), delivery rules engine (`email_rules`), column-layout desktop list option, collapse-all sidebar, remote-content blocking, per-address signatures.
**Live URL:** https://email-app-7rp.pages.dev
**GitHub:** https://github.com/johnatfreecoffee/email

## Stack
- Next.js 16 App Router, `output: "export"` → static `out/`
- React 19, Tailwind v4, Tiptap
- Backend: Cloudflare Pages Functions under `functions/api/email/*` (no Next API routes)
- Supabase project `YOUR_PROJECT_REF` (shared with MC/noknok) — tables `email_*`, `mc_sessions`, `mc_push_subscriptions`, storage bucket `email-attachments`
- Resend (inbound webhook + outbound send + domain DNS records)
- Cloudflare DNS auto-config for domains
- OpenRouter optional spam assist
- VAPID web push (self-implemented in `_web-push.ts`)

## Auth
- Header: `X-MC-Auth` (contract unchanged)
- Primary: shared-secret gate `token === env.MC_API_SECRET`
- Also accepts: valid `mc_sessions` rows + legacy hash `[redacted]`
- Client auto-seeds from `NEXT_PUBLIC_MC_API_SECRET`. No `/api/auth/*`.
- Local API: `npm run build` + `npm run dev:api` (wrangler :8788) + `npm run dev` (Next proxies `/api/*`)

## Deploy
- CF Pages project: **`email-app`** → https://email-app-7rp.pages.dev
- Workflow: `.github/workflows/deploy-cloudflare.yml` (push to `main`)
- Runtime secrets set on CF Pages (production + preview)
- Build secrets set on GitHub Actions
- Still shared with MC until cutover: Resend inbound webhook still points at `mission-control-806.pages.dev`

## Canonical docs
1. `EMAIL-SYSTEM.md` — full system brain (source of truth)
2. `KICKSTART.md` — paste-in prompt for a new chat
3. `docs/EMAIL-SPEC.md` — original design (may be stale vs code)
4. `.env.example` / `.env.local` (gitignored, real keys)

## Do not revive
- Migadu / IMAP / mailbox provisioning (cut over 2026-05-16)
- MC issues `/inbox` module
- `email-sync-cron` / `/api/email/sync`
