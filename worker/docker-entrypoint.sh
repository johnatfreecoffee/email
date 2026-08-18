#!/bin/sh
# Clone AGENT_GIT_MAP repos and start the worker.
# Mailboxes also load from Settings → Agents (Supabase). AGENT_GIT_MAP is the folder overlay.
# AGENT_GIT_MAP=a.noknok=https://github.com/org/repo.git,a.email=https://github.com/org/email.git
# AGENT_MAIL_DOMAIN=example.com
set -eu

HOME_DIR="${AGENTMAIL_HOME:-/data}"
WS="$HOME_DIR/workspaces"
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/state" "$HOME_DIR/logs" "$WS"
cp -f /opt/agentmail/worker.py "$HOME_DIR/bin/worker.py"
cp -f /opt/agentmail/access.py "$HOME_DIR/bin/access.py"

DOMAIN="${AGENT_MAIL_DOMAIN:-example.com}"
MAP="${AGENT_GIT_MAP:-}"

if [ -n "$MAP" ]; then
  echo "{\"domain\": \"$DOMAIN\", \"agents\": [" > "$HOME_DIR/agents.json"
  first=1
  echo "$MAP" | tr ',' '\n' | while IFS='=' read -r local url; do
    [ -n "$local" ] && [ -n "$url" ] || continue
    dest="$WS/$local"
    if [ ! -d "$dest/.git" ]; then
      git clone --depth 1 "$url" "$dest"
    else
      git -C "$dest" pull --ff-only || true
    fi
  done
  # rewrite agents.json in python for valid JSON
  python3 - <<PY
import json, os
from pathlib import Path
home = Path(os.environ.get("AGENTMAIL_HOME", "/data"))
domain = os.environ.get("AGENT_MAIL_DOMAIN", "example.com")
raw = os.environ.get("AGENT_GIT_MAP", "")
agents = []
for part in raw.split(","):
    if "=" not in part:
        continue
    local, url = part.split("=", 1)
    local = local.strip()
    dest = home / "workspaces" / local
    if not local:
        continue
    name = local.split(".", 1)[-1].replace(".", " ").title()
    agents.append({
        "email": f"{local}@{domain}",
        "local_part": local,
        "display_name": f"Agent {name}",
        "workspace": str(dest),
        "agent_dir": str(home / "agents" / local),
        "scope": "project",
    })
    Path(home / "agents" / local / "threads").mkdir(parents=True, exist_ok=True)
(home / "agents.json").write_text(json.dumps({"domain": domain, "agents": agents}, indent=2) + "\n")
print("agents", len(agents))
PY
fi

if [ ! -f "$HOME_DIR/config.env" ]; then
  echo "missing $HOME_DIR/config.env — mount it or set secrets as env and write the file"
  # allow env-only: write a stub from process env
  {
    echo "SUPABASE_URL=${SUPABASE_URL:-}"
    echo "SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY:-}"
    echo "RESEND_API_KEY=${RESEND_API_KEY:-}"
    echo "GROK_BIN=${GROK_BIN:-}"
    echo "POLL_SECONDS=${POLL_SECONDS:-30}"
  } > "$HOME_DIR/config.env"
fi

export AGENTMAIL_HOME="$HOME_DIR"
export AGENTMAIL_VIA=box
exec python3 "$HOME_DIR/bin/worker.py"
