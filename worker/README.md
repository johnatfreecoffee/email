# Agent worker

Lives in this repo. Runtime data is **not** a second project:

| OS | Data dir |
|---|---|
| Mac | `~/Library/AgentMail` |
| Linux | `~/.local/share/agentmail` |

`./scripts/install-local-worker.sh` copies `worker.py` + `access.py` there and starts the service.

Mailboxes come from Settings → Agents (Supabase). Optional `workspaces.json` maps `a.slug` → a folder. See `config.env.example`.

Cloud box: `BOX.md`.
