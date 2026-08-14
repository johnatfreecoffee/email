#!/bin/bash
# Install Agent Mail worker as a systemd user service.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${AGENTMAIL_HOME:-$HOME/.local/share/agentmail}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/agentmail-worker.service"

mkdir -p "$LIB/bin" "$LIB/logs" "$LIB/state" "$UNIT_DIR"
cp "$REPO/worker/worker.py" "$LIB/bin/worker.py"
cp "$REPO/worker/access.py" "$LIB/bin/access.py"
chmod +x "$LIB/bin/worker.py"

if [[ ! -f "$LIB/config.env" ]]; then
  echo "NOTE: $LIB/config.env is missing. Copy worker/config.env.example and fill keys."
fi

# Linux worker expects ROOT = ~/Library/AgentMail today. Symlink that if needed.
if [[ ! -e "$HOME/Library/AgentMail" ]]; then
  mkdir -p "$HOME/Library"
  ln -s "$LIB" "$HOME/Library/AgentMail"
fi

cat > "$UNIT" <<EOF
[Unit]
Description=Agent Mail worker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$LIB
Environment=PATH=/usr/bin:/bin:/usr/local/bin:%h/.grok/bin
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
