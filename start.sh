#!/usr/bin/env bash
# Agent Office for Linux: ./start.sh installs (first time) and opens the app.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Need Node.js 22 or newer: https://nodejs.org/"
  exit 1
fi
[ -d node_modules ] || npm install --no-fund --no-audit || exit 1
[ -f .env ] || cp .env.example .env

if command -v xdg-open >/dev/null 2>&1; then
  (for i in $(seq 1 30); do [ -f data/owner-token.txt ] && break; sleep 0.5; done; sleep 1
   xdg-open "http://localhost:${PORT}/owner?token=$(tr -d '\r\n' < data/owner-token.txt)" >/dev/null 2>&1) &
fi
echo "Agent Office: http://localhost:${PORT}  (Ctrl+C to stop)"
npm start
