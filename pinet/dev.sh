#!/usr/bin/env bash
# PiNet relay + dashboard with auto-reload
# Usage: ./dev.sh

set -e
cd "$(dirname "$0")"

TOKEN_FILE="relay-token"
PORT="${PINET_PORT:-7654}"
HTTP_PORT="${PINET_HTTP_PORT:-8081}"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "Generating $TOKEN_FILE..."
  openssl rand -hex 16 > "$TOKEN_FILE"
fi

TOKEN=$(cat "$TOKEN_FILE")

echo "╔══════════════════════════════════════╗"
echo "║  PiNet Relay                         ║"
echo "╠══════════════════════════════════════╣"
echo "║  ws://localhost:${PORT}               ║"
echo "║  http://localhost:${HTTP_PORT}             ║"
echo "║  Token: ${TOKEN}       ║"
echo "╚══════════════════════════════════════╝"
echo ""

PINET_DEMO=1 node --watch relay.js --port "$PORT" --http-port "$HTTP_PORT" --token-file "$TOKEN_FILE"
