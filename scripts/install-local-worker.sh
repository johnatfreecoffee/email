#!/bin/bash
# Install Agent Mail worker on this Mac. Copies Python into ~/Library (TCC-safe)
# and (re)loads a LaunchAgent. Does not touch config.env.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${AGENTMAIL_HOME:-$HOME/Library/AgentMail}"
LABEL="${AGENTMAIL_LABEL:-dev.freecoffee.AgentMail}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

mkdir -p "$LIB/bin" "$LIB/logs" "$LIB/state" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/AgentMail"

cp "$REPO/worker/worker.py" "$LIB/bin/worker.py"
cp "$REPO/worker/access.py" "$LIB/bin/access.py"
chmod +x "$LIB/bin/worker.py"

cat > "$LIB/run-worker.sh" <<EOF
#!/bin/bash
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:\$HOME/.grok/bin"
ROOT="$LIB"
mkdir -p "\$ROOT/logs" "\$ROOT/state"
exec >> "\$ROOT/logs/worker.log" 2>&1
echo "\$(date '+%Y-%m-%d %H:%M:%S') Agent Mail start (installed)"
exec /usr/bin/python3 "\$ROOT/bin/worker.py"
EOF
chmod +x "$LIB/run-worker.sh"

if [[ ! -f "$LIB/config.env" ]]; then
  echo "NOTE: $LIB/config.env is missing. Copy worker/config.env.example and fill keys."
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LIB}/run-worker.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${LIB}</string>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/AgentMail/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/AgentMail/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:${HOME}/.grok/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"

echo "installed $LIB"
echo "label $LABEL"
echo "heartbeat will show in Settings → Agents → Setup"
