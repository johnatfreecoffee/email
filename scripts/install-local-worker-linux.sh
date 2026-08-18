#!/bin/bash
# Install the email agent worker as a systemd user service.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${AGENTMAIL_HOME:-$HOME/.local/share/agentmail}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/agentmail-worker.service"

mkdir -p "$LIB/bin" "$LIB/logs" "$LIB/state" "$LIB/agents" "$UNIT_DIR"
cp "$REPO/worker/worker.py" "$LIB/bin/worker.py"
cp "$REPO/worker/access.py" "$LIB/bin/access.py"
chmod +x "$LIB/bin/worker.py"

if [[ ! -f "$LIB/config.env" ]]; then
  cp "$REPO/worker/config.env.example" "$LIB/config.env"
  echo "NOTE: fill $LIB/config.env (SUPABASE_*, RESEND_API_KEY, GROK_BIN)"
fi
if [[ ! -f "$LIB/workspaces.json" && -f "$REPO/worker/workspaces.json.example" ]]; then
  cp "$REPO/worker/workspaces.json.example" "$LIB/workspaces.json.example"
fi

cat > "$UNIT" <<EOF
[Unit]
Description=Email agent worker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$LIB
Environment=PATH=/usr/bin:/bin:/usr/local/bin:%h/.grok/bin
Environment=AGENTMAIL_HOME=$LIB
ExecStart=/usr/bin/python3 $LIB/bin/worker.py
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now agentmail-worker.service
echo "installed $LIB"
echo "systemctl --user status agentmail-worker"
echo "mailboxes come from Settings → Agents"
