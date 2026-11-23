#!/usr/bin/env bash
# Starts the local dashboard server (if it is not already running) and opens the page.
cd "$(dirname "$0")" || exit 1
if ! lsof -nP -iTCP:8766 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup node dashboard-server.js >/tmp/wa-dashboard.log 2>&1 &
  sleep 1
fi
open "http://127.0.0.1:8766"
