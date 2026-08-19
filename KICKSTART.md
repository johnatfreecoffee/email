# Kickstart prompt

Open a new chat, **select this folder (`~/Documents/email`) as the project**, and paste the block below.

---

You are picking up a **standalone email web app** just forked out of my larger "Mission Control" app. I want to stand it up locally, then iterate on it as its own product. It will be deleted from Mission Control once it lives here.

**Read first, in this order:**
1. `EMAIL-SYSTEM.md` — the complete brain: architecture, every API endpoint, DB schema, deployment, services, env vars, gotchas. **This is your source of truth.**
2. `README.md` — orientation + what was pruned in the fork.
3. `docs/EMAIL-SPEC.md` — original design spec (some parts predate the Resend-only cutover; trust `EMAIL-SYSTEM.md` where they disagree).

**What this is:** a Resend-only email client — add a domain → auto-configures on Resend + Cloudflare DNS → inbound mail hits a Resend webhook (`/api/email/inbound`) → rows land in Supabase `email_messages` → a three-panel Next.js UI (`/email`) reads and sends. Backend = Cloudflare Pages Functions in `functions/api/email/`. Frontend = `src/app/email` + `src/components/email/*`.

**Key facts:**
- Stack: Next.js 16 (`output: "export"`) · React 19 · Tailwind v4 · Tiptap · Supabase · Resend · Cloudflare Pages + Functions · VAPID web push.
- Uses **your** Supabase project (set `SUPABASE_URL` / keys in `.env.local`).
- Copy `.env.example` → `.env.local` and fill your own keys. Never commit them.
- The fork typechecks clean. MC's global chrome and the unrelated issues/`inbox` module were removed — this is email-only.
- Email still also lives in Mission Control (`~/Projects/mission-control`). Do **not** delete it from MC until this app is proven.

**Do this, in order:**

1. **Boot it.** `npm install` then `npm run dev`. Open http://localhost:3000 (redirects to `/email`). Confirm it compiles and renders.

2. **Wire auth for standalone use** (the one deliberate gap).
   - UI attaches `X-MC-Auth: <token>` from `localStorage["mc-auth-token"]` via `src/lib/auth.tsx` / `apiFetch`.
   - Functions validate in `functions/api/email/_shared.ts` `checkAuth` against `MC_API_SECRET`, then optional `mc_sessions` rows.
   - `auth.tsx` posts to `/api/auth/login` and `/api/auth/me`, which were **not** forked over.
   - `MC_API_SECRET` is set in `.env.local` but **not currently read by `checkAuth`** — you must teach the backend to accept it (or collapse to a shared-secret gate).
   - Recommended: shared-secret gate — make `checkAuth` accept `X-MC-Auth === env.MC_API_SECRET`, and make the client store `NEXT_PUBLIC_MC_API_SECRET` as the token (or a tiny password screen that stores it). Keep the `X-MC-Auth` header + `checkAuth → Response|null` contract.
   - Local-dev note: static `next dev` will not run Cloudflare Pages Functions. Either use `wrangler pages dev` against `out/` (or a CF-compatible local proxy), or temporarily point the UI at the live MC Functions host for API calls while iterating UI. Document which path you choose.
   - Confirm the inbox loads real Supabase messages once auth passes.

3. **Then iterate** on whatever I ask next (UI polish, threading, search, compose, domain onboarding, push, deploy as `email-app`, etc.).

**When shipping:** deploy like MC — `git init`/push to a new GitHub repo, Cloudflare Pages project **`email-app`** (see `.github/workflows/deploy-cloudflare.yml`), set GitHub build secrets + CF Pages **runtime** secrets per `EMAIL-SYSTEM.md` §10 (PATCH CF env vars **one at a time**). Re-point the Resend inbound webhook to the new host's `/api/email/inbound`. Only then delete the email module from Mission Control.

Start by reading `EMAIL-SYSTEM.md`, then boot it and tell me what you see.

---
