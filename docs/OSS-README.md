# Agent Mail

Self-hosted mail client with **agents in the mailbox**. People you allow can email `a.dev@your-domain` and get a Grok (or later, API) reply. You pick who can talk to which agent, and whether they can only ask questions or change code.

This is **one deploy per person**, not a multi-tenant SaaS. The browser is the control panel. A worker on a machine is the hands.

## You need

| Thing | Why |
|---|---|
| [Resend](https://resend.com) API key | Send + receive |
| [Supabase](https://supabase.com) project | Mail + allowlist |
| [Cloudflare](https://cloudflare.com) token | Optional auto-DNS |
| A domain | `a.*` mailboxes |
| This machine (or later a cloud box) | Code-changing agents |
| [Grok](https://x.ai) CLI on the worker | Local coding agent |

## Quick start

```bash
git clone https://github.com/johnatfreecoffee/agentmail.git
cd agentmail
cp .env.example .env.local
# fill .env.local — never commit it
npm install
# apply every file in migrations/ in the Supabase SQL editor
npm run build
npm run dev:api   # Functions :8788
npm run dev       # UI :3000
```

Point Resend’s inbound webhook at `https://YOUR_PAGES_URL/api/email/inbound`.

```bash
./scripts/install-local-worker.sh          # Mac
# ./scripts/install-local-worker-linux.sh  # Linux
# copy worker/config.env.example → ~/Library/AgentMail/config.env
```

Open the app → Settings → **Setup**. It walks the whole stack (database, Resend, domain, sign-in, then this computer / cloud box / cloud questions if you want agents). Tiles go green as each piece connects.

Then Settings → **Agents**: create mailboxes, add people, pick Questions only / Custom / All.

## How mail becomes an agent turn

1. Email hits `a.something@your-domain`
2. Not on Users / archived / that agent unchecked → Grok never starts
3. Allowed → worker prepends a hidden permission lock and runs Grok
4. Reply goes back through Resend

Grok Build that edits repos **cannot** run on Cloudflare Pages. Pages stores mail and knobs. A machine (this laptop or a cloud box) does the work.

Laptop closed: **Cloud chat** (questions only, `XAI_API_KEY`) or a **Cloud box** (`worker/BOX.md`). Do not expose the box to the public internet.

Change the run path any time in Settings → Setup.

## License

MIT — see `LICENSE`.
