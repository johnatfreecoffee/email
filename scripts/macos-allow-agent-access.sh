#!/bin/bash
# One-time Mac access for Agent Mail: wrap Grok in a stable app bundle and
# grant Documents/Desktop/Downloads so auto-updates and new project folders
# never show an Allow popup. FDA (everything) is system-protected; Documents
# covers ~/Documents where all projects live.
set -euo pipefail

ID="dev.freecoffee.grok-fda"
APP="${HOME}/Applications/GrokFDA.app"
BIN="${APP}/Contents/MacOS/grok"
SRC="${HOME}/.grok/bin/grok"
TCC="${HOME}/Library/Application Support/com.apple.TCC/TCC.db"
CSREQ_BIN="/tmp/grok-fda.csreq"

mkdir -p "${APP}/Contents/MacOS" "${HOME}/Applications"

cat > "${APP}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>grok</string>
  <key>CFBundleIdentifier</key>
  <string>${ID}</string>
  <key>CFBundleName</key>
  <string>GrokFDA</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF

if [[ -x "$SRC" || -L "$SRC" ]]; then
  REAL="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$SRC")"
  if [[ ! -x "$BIN" || "$(stat -f %z "$REAL" 2>/dev/null || echo 0)" != "$(stat -f %z "$BIN" 2>/dev/null || echo 1)" ]]; then
    cp -p "$REAL" "$BIN"
    chmod 755 "$BIN"
  fi
else
  echo "NOTE: $SRC missing — wrap Grok after it is installed"
  REAL=""
fi

if [[ -x "$BIN" ]]; then
  DR="$(codesign -d -r- "$BIN" 2>/dev/null | awk -F'designated => ' 'NF>1{print $2}')"
  if [[ -n "${DR:-}" ]]; then
    printf '%s' "$DR" | csreq -r- -b "$CSREQ_BIN"
  fi
fi

grant() {
  local service="$1" client="$2" ctype="$3"
  [[ -f "$TCC" ]] || return 0
  if [[ -f "$CSREQ_BIN" ]]; then
    sqlite3 "$TCC" "INSERT OR REPLACE INTO access(
        service, client, client_type, auth_value, auth_reason, auth_version,
        csreq, indirect_object_identifier, flags, last_modified, last_reminded
      ) VALUES (
        '$service', '$client', $ctype, 2, 2, 1,
        X'$(xxd -p -c 256 "$CSREQ_BIN" | tr -d '\n')',
        'UNUSED', 0,
        CAST(strftime('%s','now') AS INTEGER), 0
      );"
  else
    sqlite3 "$TCC" "INSERT OR REPLACE INTO access(
        service, client, client_type, auth_value, auth_reason, auth_version,
        indirect_object_identifier, flags, last_modified, last_reminded
      ) VALUES (
        '$service', '$client', $ctype, 2, 2, 1,
        'UNUSED', 0,
        CAST(strftime('%s','now') AS INTEGER), 0
      );"
  fi
}

if [[ -f "$TCC" ]]; then
  for svc in \
    kTCCServiceSystemPolicyDocumentsFolder \
    kTCCServiceSystemPolicyDesktopFolder \
    kTCCServiceSystemPolicyDownloadsFolder
  do
    grant "$svc" "$ID" 0
    if [[ -x "$BIN" ]]; then
      grant "$svc" "$BIN" 1
    fi
    if [[ -n "${REAL:-}" && -x "$REAL" ]]; then
      grant "$svc" "$REAL" 1
    fi
  done
  killall tccd 2>/dev/null || true
fi

echo "GrokFDA $APP"
if [[ -x "$BIN" ]]; then
  echo "GROK_BIN=$BIN"
fi
echo "TCC bundle $ID Documents/Desktop/Downloads allowed"
echo "Full Disk Access is system-locked; Documents covers ~/Documents (all projects)."
