#!/usr/bin/env bash
# PiNet relay + dashboard with auto-reload
# Usage: ./dev.sh

set -e
cd "$(dirname "$0")"

TOKEN_FILE="relay-token"
PORT="${PINET_PORT:-7654}"
HTTP_PORT="${PINET_HTTP_PORT:-8081}"
MACHINE="$(hostname -s 2>/dev/null || echo mac)"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "Generating $TOKEN_FILE..."
  openssl rand -hex 16 > "$TOKEN_FILE"
fi

TOKEN=$(cat "$TOKEN_FILE")

# Write relay.json so agents on this machine auto-connect
PINET_DIR="$HOME/.pinet"
mkdir -p "$PINET_DIR"
cat > "$PINET_DIR/relay.json" << EOF
{
  "url": "ws://127.0.0.1:${PORT}",
  "token": "${TOKEN}",
  "machine": "${MACHINE}"
}
EOF

echo "╔══════════════════════════════════════╗"
echo "║  PiNet Relay                         ║"
echo "╠══════════════════════════════════════╣"
echo "║  ws://localhost:${PORT}               ║"
echo "║  http://localhost:${HTTP_PORT}             ║"
echo "║  Token: ${TOKEN}       ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "relay.json written → agents just need: /pinet <name>@<team>"
echo ""

PINET_DEMO=1 node --watch relay.js --port "$PORT" --http-port "$HTTP_PORT" --token-file "$TOKEN_FILE"
