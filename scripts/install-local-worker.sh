#!/bin/bash
# Install the email agent worker on this Mac. Copies Python into ~/Library
# (TCC-safe) and (re)loads a LaunchAgent. Does not overwrite config.env.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${AGENTMAIL_HOME:-$HOME/Library/AgentMail}"
LABEL="${AGENTMAIL_LABEL:-dev.freecoffee.AgentMail}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

mkdir -p "$LIB/bin" "$LIB/logs" "$LIB/state" "$LIB/agents" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/AgentMail"

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

cat > "$LIB/run-worker.sh" <<EOF
#!/bin/bash
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:\$HOME/.grok/bin"
export AGENTMAIL_HOME="$LIB"
ROOT="$LIB"
mkdir -p "\$ROOT/logs" "\$ROOT/state"
exec >> "\$ROOT/logs/worker.log" 2>&1
echo "\$(date '+%Y-%m-%d %H:%M:%S') email worker start (installed)"
# caffeinate -i: stay awake through idle sleep. Lid-close still sleeps the Mac.
if [[ -x /usr/bin/caffeinate ]]; then
  exec /usr/bin/caffeinate -i /usr/bin/python3 "\$ROOT/bin/worker.py"
fi
exec /usr/bin/python3 "\$ROOT/bin/worker.py"
EOF
chmod +x "$LIB/run-worker.sh"
rm -f "$LIB/run-agent-mail.sh"

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
  <string>Standard</string>
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
    <key>AGENTMAIL_HOME</key>
    <string>${LIB}</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

echo "installed $LIB"
echo "label $LABEL"
echo "mailboxes come from Settings → Agents"
echo "optional folder map: $LIB/workspaces.json"
echo "heartbeat shows in Settings → Setup"
