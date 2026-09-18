#!/bin/bash
# One-time Mac access for Agent Mail.
#
# Do NOT put the xAI grok CLI at GrokFDA.app/Contents/MacOS/grok.
# That binary is a notarized Developer ID *tool*. Gatekeeper then treats the
# .app as a bundle with no sealed resources and shows:
#   "GrokFDA is damaged and can't be opened."
#
# Instead:
#   ~/Library/AgentMail/bin/grok  — stable path, original xAI signature
#   ~/Applications/GrokFDA.app    — tiny ad-hoc stub (not GROK_BIN)
# TCC: path grant on the stable CLI (team csreq survives auto-updates) plus
# the bundle id for leftover LaunchServices identity.
set -euo pipefail

ID="dev.freecoffee.grok-fda"
APP="${HOME}/Applications/GrokFDA.app"
STUB="${APP}/Contents/MacOS/GrokFDA"
LIB="${AGENTMAIL_HOME:-$HOME/Library/AgentMail}"
STABLE="${LIB}/bin/grok"
SRC="${HOME}/.grok/bin/grok"
TCC="${HOME}/Library/Application Support/com.apple.TCC/TCC.db"
CSREQ_BIN="/tmp/grok-fda.csreq"
STUB_C="/tmp/GrokFDA-stub.c"

mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources" "${LIB}/bin" "${HOME}/Applications"

cat > "${APP}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>GrokFDA</string>
  <key>CFBundleIdentifier</key>
  <string>${ID}</string>
  <key>CFBundleName</key>
  <string>GrokFDA</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.1</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF

REAL=""
if [[ -x "$SRC" || -L "$SRC" ]]; then
  REAL="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$SRC")"
fi

if [[ -n "${REAL}" && -x "$REAL" ]]; then
  if [[ ! -x "$STABLE" || "$(stat -f %z "$REAL" 2>/dev/null || echo 0)" != "$(stat -f %z "$STABLE" 2>/dev/null || echo 1)" ]]; then
    cp -X "$REAL" "$STABLE"
    chmod 755 "$STABLE"
    xattr -c "$STABLE" 2>/dev/null || true
  fi
else
  echo "NOTE: $SRC missing — wrap Grok after it is installed"
fi

cat > "$STUB_C" <<EOF
#include <unistd.h>
#include <stdio.h>
int main(int argc, char **argv) {
  const char *grok = "${STABLE}";
  execv(grok, argv);
  perror(grok);
  return 127;
}
EOF
if cc -O2 -o "$STUB" "$STUB_C" 2>/dev/null; then
  chmod 755 "$STUB"
else
  echo "NOTE: cc failed — GrokFDA stub not rebuilt"
fi

# Old wrap copied grok itself into Contents/MacOS/grok (the damaged-app bug).
OLD_EXE="${APP}/Contents/MacOS/grok"
if [[ -e "$OLD_EXE" ]]; then
  if pgrep -f "${APP}/Contents/MacOS/grok" >/dev/null 2>&1; then
    echo "NOTE: GrokFDA grok in use — leave Contents/MacOS/grok until that job exits"
  else
    rm -f "$OLD_EXE"
  fi
fi

xattr -cr "$APP" 2>/dev/null || true
if [[ -x "$STUB" ]]; then
  codesign --force --sign - --identifier "$ID" --options runtime "$STUB" 2>/dev/null || true
  codesign --force --sign - --identifier "$ID" --options runtime "$APP" 2>/dev/null || true
fi

rm -f "$CSREQ_BIN"
if [[ -x "$STABLE" ]]; then
  DR="$(codesign -d -r- "$STABLE" 2>/dev/null | awk -F'designated => ' 'NF>1{print $2}')"
  if [[ -n "${DR:-}" ]]; then
    printf '%s' "$DR" | csreq -r- -b "$CSREQ_BIN" || true
  fi
fi

grant() {
  local service="$1" client="$2" ctype="$3" use_csreq="${4:-1}"
  [[ -f "$TCC" ]] || return 0
  if [[ "$use_csreq" == "1" && -f "$CSREQ_BIN" ]]; then
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
    grant "$svc" "$ID" 0 0
    if [[ -x "$STABLE" ]]; then
      grant "$svc" "$STABLE" 1 1
    fi
    if [[ -n "${REAL:-}" && -x "$REAL" ]]; then
      grant "$svc" "$REAL" 1 1
    fi
  done
  killall tccd 2>/dev/null || true
fi

echo "GrokFDA stub $APP"
if [[ -x "$STABLE" ]]; then
  echo "GROK_BIN=$STABLE"
fi
echo "TCC path $STABLE + bundle $ID Documents/Desktop/Downloads allowed"
echo "Full Disk Access is system-locked; Documents covers ~/Documents (all projects)."
