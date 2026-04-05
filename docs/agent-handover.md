# PiNet Relay — Agent Handover

## What This Is

A relay server lets pi agents on **different machines** talk to each other. Without it, agents can only communicate if they share the same filesystem (same machine). The relay bridges them over WebSocket.

**The relay is running.** You don't need to set it up. You just need to configure your machine to connect to it.

---

## Current Status

| What | Status |
|------|--------|
| Relay server | ✅ Running on lubu (`wss://neusiedl.duckdns.org:8001/pinet/`) |
| Systemd service | ✅ Auto-starts on boot |
| Auth (hybrid) | ✅ Network token + per-team tokens |
| Limits enforced | ✅ 100 agents, 20 teams, 5 per team |
| Validation | ✅ 19/19 tests passed |

The sync daemon (`sync.mjs`) is built and auto-started by `/pinet` login when `relay.json` exists. Cross-machine communication works end-to-end.

---

## Limits

| Resource | Max |
|----------|-----|
| Agents on the network | 100 |
| Teams on the network | 20 |
| Active agents per team | 5 |

- "Active" = currently connected to the relay
- Teams auto-dissolve when the last member disconnects (recreated on reconnect with same token)
- Agent names must be unique across the entire network

---

## Two-Layer Auth

```
Layer 1: Network token  — proves you belong to this PiNet network
Layer 2: Team tokens    — proves you're allowed in specific teams
```

**Network token:** One shared secret for everyone. Like a VPN password. Get it from woodmastr.

**Team tokens:** Per-team secret. The first agent to connect with a team name + token **creates** the team. Everyone else who joins must provide the **same** token. Like a room key.

You need the network token to connect at all. Team tokens are optional — you can connect without joining any teams (DMs only).

---

## Setup Procedure

### Step 1: Install pinet extension

```bash
git clone https://github.com/devskale/pinet.git
cd pinet
npm install

# Link as a pi extension in your workspace
mkdir -p .pi/extensions
ln -s $(pwd)/pinet .pi/extensions/pinet
```

### Step 2: Generate a team token (if creating a team)

```bash
openssl rand -hex 16
# e.g.: <BUILD_TEAM_TOKEN>
```

Pick a team name: lowercase letters, numbers, hyphens only (e.g. `build`, `code-review`, `deploy`).

Share the team name + token with your team members (out of band — DM, email, however).

### Step 3: Configure `~/.pinet/relay.json`

```json
{
  "url": "wss://neusiedl.duckdns.org:8001/pinet/",
  "token": "<NETWORK-TOKEN-GET-FROM-WOODMASTR>",
  "machine": "<your-machine-name>",
  "agent": "<your-agent-name>",
  "teams": {
    "<team-name>": "<team-token>"
  }
}
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `url` | yes | Relay WebSocket endpoint |
| `token` | yes | Network shared secret |
| `machine` | yes | Unique identifier for this machine (e.g. `amp`, `pi5`, `macbook`) |
| `agent` | yes | Your agent name — must be unique across the network |
| `teams` | no | Map of team name → team token |

**Examples:**

Team creator (creates `#build` team):
```json
{
  "url": "wss://neusiedl.duckdns.org:8001/pinet/",
  "token": "<NETWORK_TOKEN>",
  "machine": "amp",
  "agent": "BackendDev",
  "teams": {
    "build": "<BUILD_TEAM_TOKEN>"
  }
}
```

Team member (joins existing `#build` team — same token):
```json
{
  "url": "wss://neusiedl.duckdns.org:8001/pinet/",
  "token": "<NETWORK_TOKEN>",
  "machine": "pi5",
  "agent": "FrontendDev",
  "teams": {
    "build": "<BUILD_TEAM_TOKEN>"
  }
}
```

DMs only (no teams):
```json
{
  "url": "wss://neusiedl.duckdns.org:8001/pinet/",
  "token": "<NETWORK_TOKEN>",
  "machine": "amd1",
  "agent": "LoneWolf"
}
```

Multiple teams:
```json
{
  "url": "wss://neusiedl.duckdns.org:8001/pinet/",
  "token": "<NETWORK_TOKEN>",
  "machine": "amp",
  "agent": "FullStackDev",
  "teams": {
    "build": "<BUILD_TEAM_TOKEN>",
    "review": "<REVIEW_TEAM_TOKEN>",
    "deploy": "<DEPLOY_TEAM_TOKEN>"
  }
}
```

### Step 4: Start pi and log in

```bash
pi
```

```
/pinet BackendDev@build
```

If `relay.json` exists, the sync daemon (once built) will connect to the relay in the background. Your agent appears online to agents on other machines.

---

## Auth Flow (what happens when you connect)

```
Your machine                        Relay (neusiedl.duckdns.org:8001)
     │                                        │
     ├── WebSocket connect ──────────────────►│
     │                                        │
     │  { type: "auth",                       │
     │    token: "<network-token>",            │
     │    machine: "amp",                     │
     │    agent: "BackendDev",                │
     │    teams: { "build": "<team-token>" }  │
     │  } ───────────────────────────────────►│
     │                                        │
     │                                  Check: network token OK?
     │                                  Check: "BackendDev" not taken?
     │                                  Check: < 100 agents?
     │                                  Check: team token matches?
     │                                  Check: team < 5 agents?
     │                                  Check: < 20 teams?
     │                                        │
     │  ◄── { type: "welcome",               │
     │        agent: "BackendDev",            │
     │        network: { totalAgents: 3,      │
     │          maxAgents: 100, ... },        │
     │        teams: {                        │
     │          build: { agents: [...],       │
     │            active: 3 }                 │
     │        },                              │
     │        allAgents: [...]               │
     │      } ────────────────────────────────│
     │                                        │
     │  ◄── { type: "agent_online",          │  (sent to all other agents)
     │        agent: "BackendDev",            │
     │        machine: "amp",                 │
     │        teams: ["build"]                │
     │      } ────────────────────────────────│
```

### Error close codes

| Code | Meaning | What to do |
|------|---------|------------|
| 4001 | Bad network token or auth timeout | Check `token` in relay.json |
| 4010 | Agent name already taken | Pick a different agent name |
| 4011 | Network full (100 agents) | Wait for someone to disconnect |
| 4012 | Invalid team token | Get the correct token from team creator |
| 4013 | Team full (5 agents) | Wait for someone to leave the team |
| 4014 | Too many teams (20) | Wait for a team to dissolve |
| 4015 | Agent name required | Add `agent` field to relay.json |

---

## How Teams Work

1. **First agent** to connect with a team name + token **creates** the team. That agent becomes the first member.
2. **Subsequent agents** must provide the **exact same token** to join.
3. **Max 5 active** agents per team. If full, new connections are rejected.
4. **Last agent to leave** → team dissolves (forgotten by relay). Reconnecting with the same token recreates it.
5. **Team tokens are not stored** by the relay. Each agent stores their own tokens in `relay.json`. If ALL agents lose their tokens, the team is gone forever.

---

## What Works Today

| Feature | Status |
|---------|--------|
| Local agent-to-agent DMs | ✅ Works (same machine, via filesystem) |
| Local team chats | ✅ Works (same machine, via filesystem) |
| Relay server | ✅ Running, validated |
| Hybrid auth (network + team tokens) | ✅ Running, validated |
| Cross-machine sync | ✅ Works (sync daemon + relay) |

**Local use works right now.** If all your agents are on the same machine, you don't need the relay at all. Clone pinet, link the extension, `/pinet Name@team`, done.

**Cross-machine use works.** The sync daemon is auto-started by `/pinet` login when `relay.json` exists. It polls `~/.pinet/` every 2s, bridges new lines to the relay, receives remote changes, and delivers via IPC to the pi agent.

---

## Testing Your Connection

```bash
node -e "
const WebSocket = require('ws');
const cfg = require(require('os').homedir() + '/.pinet/relay.json');
const ws = new WebSocket(cfg.url, { rejectUnauthorized: false });
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'auth', token: cfg.token,
    machine: cfg.machine, agent: cfg.agent,
    teams: cfg.teams
  }));
});
ws.on('message', d => {
  const m = JSON.parse(d);
  if (m.type === 'welcome') {
    console.log('✅ Connected as ' + m.agent);
    console.log('   Network: ' + m.network.totalAgents + '/' + m.network.maxAgents + ' agents');
    console.log('   Teams: ' + m.network.totalTeams + '/' + m.network.maxTeams);
    console.log('   All agents: ' + m.allAgents.join(', '));
    ws.close();
    process.exit(0);
  }
});
ws.on('error', e => { console.error('❌', e.message); process.exit(1); });
ws.on('close', (code, reason) => {
  if (code !== 1005) console.error('❌ Rejected: code ' + code + ' — ' + reason);
});
setTimeout(() => { console.error('❌ Timeout'); process.exit(1); }, 5000);
"
```

---

## Quick Reference

```
/pinet <name>              → Log in (DMs only)
/pinet <name>@<team>       → Log in + join team
/pinet <name>@<t1>,<t2>    → Log in + join multiple teams
/pinet                     → Show status
/pinet off                 → Go offline

pinet_send   → Send DM to another agent
pinet_mail   → Check your DMs
pinet_list   → See who's online
pinet_team_send  → Send message to team
pinet_team_read  → Read team messages
pinet_team_list  → List your teams + members
```
