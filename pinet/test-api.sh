#!/usr/bin/env bash
# PiNet API test script
# Usage: ./test-api.sh [relay_url] [token]
#
# Examples:
#   ./test-api.sh                          # defaults to localhost
#   ./test-api.sh http://localhost:8081 testlocal123

set -e

BASE="${1:-http://localhost:8081}"
TOKEN="${2:-testlocal123}"

# Auth helper
auth="-H \"Authorization: Bearer $TOKEN\""

echo "══════════════════════════════════════"
echo "  PiNet API Test"
echo "  Relay: $BASE"
echo "  Token: $TOKEN"
echo "══════════════════════════════════════"
echo ""

# ── 1. Stats ──────────────────────────────────────────────────────
echo "── 1. GET /api/stats"
curl -s "$BASE/api/stats" | python3 -m json.tool
echo ""

# ── 2. Conversations ──────────────────────────────────────────────
echo "── 2. GET /api/conversations"
curl -s "$BASE/api/conversations?token=$TOKEN" | python3 -m json.tool
echo ""

# ── 3. Send DM to agent ───────────────────────────────────────────
echo "── 3. POST /api/mailbox/agenta (send DM)"
RESP=$(curl -s -X POST "$BASE/api/mailbox/agenta" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"hello from test-api"}')
echo "$RESP" | python3 -m json.tool
echo ""

# ── 4. Read agent mailbox ─────────────────────────────────────────
echo "── 4. GET /api/mailbox/agenta (read DMs)"
curl -s "$BASE/api/mailbox/agenta?token=$TOKEN" | python3 -m json.tool
echo ""

# ── 5. Send team message ──────────────────────────────────────────
echo "── 5. POST /api/messages/build (send to team)"
RESP=$(curl -s -X POST "$BASE/api/messages/build" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"team message from test-api"}')
echo "$RESP" | python3 -m json.tool
echo ""

# ── 6. Read team messages ─────────────────────────────────────────
echo "── 6. GET /api/messages/build (read team)"
curl -s "$BASE/api/messages/build?token=$TOKEN" | python3 -m json.tool
echo ""

# ── 7. Projects ───────────────────────────────────────────────────
echo "── 7. GET /api/projects"
curl -s "$BASE/api/projects?token=$TOKEN" | python3 -m json.tool
echo ""

echo "══════════════════════════════════════"
echo "  Done"
echo "══════════════════════════════════════"
