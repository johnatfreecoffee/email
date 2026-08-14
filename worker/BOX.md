# Cloud box

Same Agent Mail worker, in Docker. It clones git remotes and can change those clones. **This is a privileged VM.** Treat `SUPABASE_SERVICE_KEY` and any GitHub token like production.

It does **not** run on Cloudflare Pages. Pages is the control panel. The box is the hands when your laptop is closed.

## What it can do

- Heartbeat as **Cloud box** on Settings → Agents → Setup
- Same allowlist + Questions only / Custom / All
- Claim lock: local Mac and box cannot process the same message

## What you still need

- `GROK_BIN` in the image, or install the Grok CLI in the container (needs your xAI/Grok login)
- Git remotes the box can clone (`AGENT_GIT_MAP`)
- Optional deploy-key / GitHub App if you want it to push PRs (not wired by default)

## Run locally (dry)

```bash
cd worker
docker build -t agentmail-box .
docker run --rm \
  -e SUPABASE_URL= \
  -e SUPABASE_SERVICE_KEY= \
  -e RESEND_API_KEY= \
  -e AGENT_MAIL_DOMAIN=example.com \
  -e AGENT_GIT_MAP=a.dev=https://github.com/you/repo.git \
  agentmail-box
```

## Fly (you opt in)

See `fly.toml`. I will not create a paid Fly app unless you say so.
