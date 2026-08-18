# Email (clone this repo)

Self-hosted mail client. Optional **agents in the mailbox**: people you allow can email `a.dev@your-domain` and get a Grok reply. You pick who can talk to which agent, and whether they can only ask questions or change code.

This is **one deploy per person**, not a multi-tenant SaaS. The browser is the control panel. A worker on a machine is the hands.

There is no second project. Clone **this** repo.

## You need

| Thing | Why |
|---|---|
| [Resend](https://resend.com) API key | Send + receive |
| [Supabase](https://supabase.com) project | Mail + allowlist |
| [Cloudflare](https://cloudflare.com) token | Optional auto-DNS |
| A domain | Inbox + `a.*` mailboxes |
| This machine (or a cloud box) | Code-changing agents |
| [Grok](https://x.ai) CLI on the worker | Local coding agent |

## Quick start

```bash
git clone https://github.com/johnatfreecoffee/email.git
cd email
cp .env.example .env.local
# fill .env.local — never commit it
npm install
# apply every file in migrations/ in the Supabase SQL editor
npm run build
npm run dev:api   # Functions :8788
npm run dev       # UI :3000
```

Point Resend’s inbound webhook at `https://YOUR_PAGES_URL/api/email/inbound`.

Agents (optional):

```bash
./scripts/install-local-worker.sh          # Mac
# ./scripts/install-local-worker-linux.sh  # Linux
# fill ~/Library/AgentMail/config.env (or ~/.local/share/agentmail/config.env)
```

Open the app → Settings → **Setup**. Tiles go green as each piece connects.

Then Settings → **Agents**: create mailboxes, add people, pick Questions only / Custom / All.

The worker reads those mailboxes from the database. It opens `WORKSPACE_ROOT/<name>` (default `~/Documents/name`). To point a mailbox at another folder, add `workspaces.json` next to `config.env`:

```json
{ "a.dev": "~/src/my-app" }
```

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
