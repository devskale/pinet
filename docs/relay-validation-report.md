# PiNet Relay — Validation Report

**Server:** lubuntu (lubuntu)  
**Date:** 2026-04-03  
**External IP:** 194.152.165.85  
**Domain:** neusiedl.duckdns.org  
**Relay endpoint:** `wss://neusiedl.duckdns.org:8001/pinet/`  

---

## Architecture

```
Remote agents                         lubu (neusiedl.duckdns.org)
                                       ┌──────────────────────────────┐
wss://neusiedl.duckdns.org:8001/pinet/ │  nginx (:8001, SSL)          │
         │                             │  /pinet/ → proxy_pass       │
         └────────────────────────────►│           :7654              │
                                       │  pinet-relay.service (:7654) │
                                       │  token-file relay-token      │
                                       └──────────────────────────────┘
```

- **Internal port:** 7654 (relay listens on localhost only)
- **External port:** 8001 (nginx SSL reverse proxy)
- **SSL:** Self-signed cert for `neusiedl.duckdns.org` (valid until 2026-05-08)
- **Token:** 48-char hex shared secret in `~/code/pinet/relay-token`
- **Service:** systemd, enabled, auto-starts on boot

---

## Files Created/Modified

| File | Purpose |
|------|---------|
| `~/code/pinet/pinet/relay.js` | Relay server (modified: added `--token-file` flag, try-catch in broadcast) |
| `~/code/pinet/relay-token` | Shared secret token |
| `~/code/pinet/pinet-relay.service` | Systemd unit file |
| `/etc/systemd/system/pinet-relay.service` | Installed service |
| `~/.pinet/relay.json` | Local agent auto-connect config |
| `/etc/nginx/sites-available/neusiedl` | Modified: added `/pinet/` WebSocket proxy location |
| `~/configs/nginx/pinet-relay.conf` | Reference copy of the nginx location block |

---

## Test Results: 24/24 Passed

### Systemd Service (2/2)

| Test | Result | Detail |
|------|--------|--------|
| Service active | ✅ | `active` |
| Service enabled at boot | ✅ | `enabled` |

### Local Relay — ws://127.0.0.1:7654 (6/6)

| Test | Result | Detail |
|------|--------|--------|
| Correct token auth | ✅ | Welcome received |
| Bad token rejected | ✅ | Close code 4001 |
| Unauthenticated data rejected | ✅ | Close code 4001 |
| Ping/Pong | ✅ | Pong received |
| Multi-client fan-out (3 machines) | ✅ | All join/leave/welcome events correct |
| Crash resilience | ✅ | Relay survived 5 rapid disconnects + reconnect |

### Nginx Proxy (3/3)

| Test | Result | Detail |
|------|--------|--------|
| Config syntax valid | ✅ | `nginx -t` successful (warnings: duplicate MIME in jot-locations.conf, pre-existing) |
| Nginx running | ✅ | `active` |
| `/pinet/` location in neusiedl | ✅ | Found in server block |

### External Endpoint — wss://neusiedl.duckdns.org:8001/pinet/ (3/3)

| Test | Result | Detail |
|------|--------|--------|
| External WSS connect + auth | ✅ | TLS handshake + auth through nginx proxy |
| External bad token rejected | ✅ | Close code 4001 |
| External fan-out | ✅ | Client A saw Client B join through proxy |

### Config Files (5/5)

| Test | Result | Detail |
|------|--------|--------|
| relay.js exists | ✅ | `~/code/pinet/pinet/relay.js` |
| relay-token exists | ✅ | `~/code/pinet/relay-token` |
| Service file installed | ✅ | `/etc/systemd/system/pinet-relay.service` |
| `~/.pinet/relay.json` exists | ✅ | |
| Nginx config saved | ✅ | `~/configs/nginx/pinet-relay.conf` |

### Config Validation (3/3)

| Test | Result | Detail |
|------|--------|--------|
| relay.json url | ✅ | `wss://neusiedl.duckdns.org:8001/pinet/` |
| relay.json machine | ✅ | `lubu` |
| relay.json token | ✅ | 48-char hex |

### Network (2/2)

| Test | Result | Detail |
|------|--------|--------|
| External IP reachable | ✅ | 194.152.165.85 |
| DNS resolves | ✅ | neusiedl.duckdns.org → 194.152.165.85 |

---

## Bug Fix Applied

**Issue:** `ws.send()` threw unhandled exceptions when writing to WebSocket connections in a transitional state (CLOSING/CLOSED) during rapid client disconnects, crashing the relay process.

**Fix:** Wrapped all `ws.send()` calls in `send()` and `broadcast()` with try-catch. Socket write errors during transitional states are now silently ignored — the `close` handler already cleans up the `machines` map.

---

## Connecting Other Machines

On any other machine, create `~/.pinet/relay.json`:

```json
{
  "url": "wss://neusiedl.duckdns.org:8001/pinet/",
  "token": "095f4fe80bf41b829ca49286ff34e34eb52bcf63daa126db",
  "machine": "machine-name"
}
```

The sync daemon (Phase 4, not yet implemented) will read this and bridge `~/.pinet/` filesystem changes through the relay. Currently the relay is operational and ready for sync daemon integration.

---

## Management Commands

```bash
# Service
sudo systemctl status pinet-relay
sudo systemctl restart pinet-relay
sudo systemctl stop pinet-relay
sudo journalctl -u pinet-relay -f          # live logs

# Nginx
sudo nginx -t                              # test config
sudo systemctl reload nginx                # reload config

# Manual test
node -e "
  const WebSocket = require('ws');
  const ws = new WebSocket('wss://neusiedl.duckdns.org:8001/pinet/', {rejectUnauthorized:false});
  ws.on('open', () => ws.send(JSON.stringify({type:'auth',token:'095f4fe80bf41b829ca49286ff34e34eb52bcf63daa126db',machine:'test'})));
  ws.on('message', d => { console.log(JSON.parse(d)); if(JSON.parse(d).type==='welcome'){ws.close();process.exit(0)} });
  ws.on('error', e => { console.error(e.message); process.exit(1); });
  setTimeout(()=>process.exit(1),5000);
"
```
