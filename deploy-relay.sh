#!/bin/bash
# PiNet Relay Deploy Script — run from any machine with ssh access to lubu
# Usage: ./deploy-relay.sh

set -e

REMOTE_HOST="${1:-lubuntu}"
REMOTE_USER="${2:-woodmastr}"
REMOTE_DIR="/home/$REMOTE_USER/code/pinet"

echo "=== PiNet Relay Deploy ==="
echo "Target: $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"
echo ""

# 1. Push to origin (so remote can pull)
echo ">>> Pushing to origin..."
git push

# 2. SSH to lubu and deploy
echo ">>> Deploying on $REMOTE_HOST..."
ssh "$REMOTE_USER@$REMOTE_HOST" bash -s <<DEPLOY
set -e
cd $REMOTE_DIR

echo ">>> Pulling latest..."
git pull

echo ">>> Installing dependencies..."
cd pinet && npm install

echo ">>> Updating systemd service..."
sudo cp $REMOTE_DIR/pinet-relay.service /etc/systemd/system/pinet-relay.service
sudo systemctl daemon-reload

echo ">>> Restarting relay..."
sudo systemctl restart pinet-relay

sleep 2

echo ">>> Status:"
sudo systemctl status pinet-relay --no-pager -l | head -15

echo ""
echo ">>> Testing relay..."
sleep 1
curl -s http://localhost:7654 2>/dev/null && echo "" || true

echo ">>> Testing dashboard..."
curl -s http://localhost:8080/api/stats | python3 -m json.tool 2>/dev/null || echo "(stats not ready yet)"

echo ""
echo "=== Deploy complete ==="
echo "Relay:    ws://$REMOTE_HOST:7654"
echo "Dashboard: http://$REMOTE_HOST:8080"
echo "Stats API: http://$REMOTE_HOST:8080/api/stats"
DEPLOY
