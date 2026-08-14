#!/bin/bash
# Stop the worker. Leaves config.env + logs in place.
set -euo pipefail

LABEL="${AGENTMAIL_LABEL:-dev.freecoffee.AgentMail}"
UID_NUM="$(id -u)"

if [[ "$(uname -s)" == "Darwin" ]]; then
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  echo "stopped $LABEL"
  exit 0
fi

systemctl --user disable --now agentmail-worker.service 2>/dev/null || true
echo "stopped agentmail-worker"
