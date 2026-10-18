#!/usr/bin/env bash
# Agent Office for Linux: ./start.sh installs (first time) and opens the window.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"

if ! command -v node >/dev/null 2>&1; then
  echo "Need Node.js 20 or newer: https://nodejs.org/"
  exit 1
fi
[ -d node_modules ] || npm install --no-fund --no-audit || exit 1

if command -v xdg-open >/dev/null 2>&1; then
  (sleep 2; xdg-open "http://localhost:${PORT}" >/dev/null 2>&1) &
fi
echo "Agent Office: http://localhost:${PORT}  (Ctrl+C to stop)"
echo "Now open Claude Code in this folder and give it a task."
npm start
