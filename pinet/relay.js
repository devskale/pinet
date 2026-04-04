#!/usr/bin/env node
/**
 * PiNet Relay — WebSocket fan-out for cross-machine agent sync.
 *
 * Usage:
 *   node relay.js --port 7654 --token-file relay-token
 *
 * Two-layer auth:
 *   1. Network token — proves you belong to this PiNet network
 *   2. Agent identity + team tokens — per-team access control
 *
 * Limits:
 *   100 agents max across the network
 *   20 teams max
 *   5 agents max per team
 *
 * Protocol:
 *   Client → Relay: auth, append, write, ping
 *   Relay → Client: welcome, agent_online, agent_offline, append, write, pong
 *
 * Auth message:
 *   {
 *     "type": "auth",
 *     "token": "<network-token>",
 *     "machine": "amp",
 *     "agent": "BackendDev",
 *     "teams": { "build": "<team-token>", "review": "<team-token>" }
 *   }
 *
 * Close codes:
 *   4000  invalid JSON
 *   4001  auth timeout / required / bad network token
 *   4002  replaced by new connection (same agent, same machine)
 *   4003  heartbeat timeout
 *   4010  agent name already taken
 *   4011  network full (100 agents)
 *   4012  invalid team token
 *   4013  team full (5 agents)
 *   4014  too many teams (20)
 *   4015  agent name required
 */

const { parseArgs } = require("node:util");
const fs = require("node:fs");

// =============================================================================
// CLI
// =============================================================================

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "7654" },
    "http-port": { type: "string", default: "8081" },
    token: { type: "string" },
    "token-file": { type: "string" },
    "heartbeat-ms": { type: "string", default: "30000" },
    "auth-timeout-ms": { type: "string", default: "5000" },
  },
  strict: true,
});

const TOKEN = values["token-file"]
  ? fs.readFileSync(values["token-file"], "utf-8").trim()
  : values.token;

if (!TOKEN) {
  console.error("Usage: node relay.js --port 7654 --token <secret>");
  console.error("       node relay.js --port 7654 --token-file <path>");
  process.exit(1);
}

const PORT = parseInt(values.port, 10);
const HTTP_PORT = parseInt(values["http-port"], 10) || 8081;
const HEARTBEAT_MS = parseInt(values["heartbeat-ms"], 10);
const AUTH_TIMEOUT_MS = parseInt(values["auth-timeout-ms"], 10);

// =============================================================================
// Limits
// =============================================================================

const MAX_AGENTS = 100;
const MAX_TEAMS = 20;
const MAX_PER_TEAM = 5;

// =============================================================================
// Close codes
// =============================================================================

const CLOSE = {
  INVALID_JSON: 4000,
  AUTH_REQUIRED: 4001,
  REPLACED: 4002,
  HEARTBEAT: 4003,
  AGENT_TAKEN: 4010,
  NETWORK_FULL: 4011,
  BAD_TEAM_TOKEN: 4012,
  TEAM_FULL: 4013,
  TOO_MANY_TEAMS: 4014,
  AGENT_REQUIRED: 4015,
};

// =============================================================================
// WebSocket
// =============================================================================

let WebSocket;
try {
  WebSocket = require("ws");
} catch {
  console.error("'ws' package not found. Install it: npm install ws");
  process.exit(1);
}

// =============================================================================
// State — in-memory only, rebuilt from client connections on restart
// =============================================================================

/** agentName → { machine: string, ws, teams: Set<string> } */
const agents = new Map();

/** teamName → { token: string, agents: Set<string> } */
const teams = new Map();

// =============================================================================
// Server
// =============================================================================

const startedAt = new Date().toISOString();

// =============================================================================
// HTTP server — dashboard + stats API
// =============================================================================

const http = require("http");

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PiNet Relay</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:2rem}
h1{color:#58a6ff;margin-bottom:.5rem;font-size:1.8rem}
.subtitle{color:#8b949e;margin-bottom:2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.2rem}
.card .label{color:#8b949e;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
.card .value{color:#58a6ff;font-size:2rem;font-weight:700;margin-top:.3rem}
.card .value.green{color:#3fb950}
.card .max{color:#484f58;font-size:.9rem}
.section{margin-bottom:2rem}
.section h2{color:#c9d1d9;font-size:1.1rem;margin-bottom:.8rem;border-bottom:1px solid #21262d;padding-bottom:.5rem}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:#8b949e;font-weight:500;font-size:.8rem;text-transform:uppercase;padding:.5rem .8rem;border-bottom:1px solid #21262d}
td{padding:.5rem .8rem;border-bottom:1px solid #21262d;font-size:.9rem}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:.5rem}
.dot.on{background:#3fb950}
.refresh{color:#484f58;font-size:.8rem;margin-top:1rem}
</style>
</head>
<body>
<h1>⚡ PiNet Relay</h1>
<p class="subtitle" id="uptime">—</p>
<div class="grid">
  <div class="card"><div class="label">Agents Online</div><div class="value green" id="agents">0</div><div class="max" id="agents-max"></div></div>
  <div class="card"><div class="label">Active Teams</div><div class="value" id="teams">0</div><div class="max" id="teams-max"></div></div>
  <div class="card"><div class="label">Started</div><div class="value" id="started" style="font-size:1.1rem">—</div></div>
</div>
<div class="section"><h2>Agents</h2><table><thead><tr><th>Name</th><th>Machine</th><th>Teams</th></tr></thead><tbody id="agent-table"></tbody></table></div>
<div class="section"><h2>Teams</h2><table><thead><tr><th>Team</th><th>Members</th><th>Capacity</th></tr></thead><tbody id="team-table"></tbody></table></div>
<p class="refresh">Auto-refreshes every 10s</p>
<script>
function fmt(iso){const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);const d=Math.floor(s/86400);const h=Math.floor(s%86400/3600);const m=Math.floor(s%3600/60);return d>0?d+"d "+h+"h":h>0?h+"h "+m+"m":m+"m"}
function refresh(){fetch("/api/stats").then(r=>r.json()).then(d=>{document.getElementById("agents").textContent=d.agents.length;document.getElementById("agents-max").textContent="of "+d.maxAgents;document.getElementById("teams").textContent=d.teamList.length;document.getElementById("teams-max").textContent="of "+d.maxTeams;document.getElementById("started").textContent=new Date(d.startedAt).toLocaleString();document.getElementById("uptime").textContent="Up "+fmt(d.startedAt)+" — "+d.agents.length+" agents, "+d.teamList.length+" teams";const at=document.getElementById("agent-table");at.innerHTML=d.agents.map(a=>"<tr><td><span class=\"dot on\"></span>"+a.name+"</td><td>"+a.machine+"</td><td>"+a.teams.map(t=>"#"+t).join(", ")+"</td></tr>").join("");const tt=document.getElementById("team-table");tt.innerHTML=d.teamList.map(t=>"<tr><td>#"+t.name+"</td><td>"+t.members.join(", ")+"</td><td>"+t.members.length+"/"+t.max+"</td></tr>").join("")}).catch(()=>{})}
refresh();setInterval(refresh,10000);
</script>
</body>
</html>`;

const httpServer = http.createServer((req, res) => {
  if (req.url === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    const teamList = [...teams.entries()].map(([name, data]) => ({
      name, members: [...data.agents], max: MAX_PER_TEAM,
    }));
    const agentList = [...agents.entries()].map(([name, data]) => ({
      name, machine: data.machine, teams: [...data.teams],
    }));
    res.end(JSON.stringify({
      startedAt, uptime: Date.now() - new Date(startedAt).getTime(),
      agents: agentList, maxAgents: MAX_AGENTS,
      teamList, maxTeams: MAX_TEAMS,
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(DASHBOARD_HTML);
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`Dashboard on http://localhost:${HTTP_PORT}`);
});

// =============================================================================
// WebSocket server
// =============================================================================

const wss = new WebSocket.Server({ port: PORT });

wss.on("listening", () => {
  console.log(`PiNet relay listening on :${PORT}`);
  console.log(`Limits: ${MAX_AGENTS} agents, ${MAX_TEAMS} teams, ${MAX_PER_TEAM}/team`);
  console.log(`Heartbeat: ${HEARTBEAT_MS / 1000}s, auth timeout: ${AUTH_TIMEOUT_MS / 1000}s`);
  console.log(`Ready.`);
});

// ─────────────────────────────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  let authenticated = false;
  let agentName = null;
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // Auth timeout — must send auth within this time
  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(CLOSE.AUTH_REQUIRED, "auth timeout");
  }, AUTH_TIMEOUT_MS);

  // Heartbeat
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // ── Message handler ──────────────────────────────────────────────────────

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      ws.close(CLOSE.INVALID_JSON, "invalid json");
      return;
    }

    // ── Auth ──────────────────────────────────────────────────────────

    if (!authenticated) {
      if (msg.type !== "auth") {
        ws.close(CLOSE.AUTH_REQUIRED, "auth required");
        return;
      }

      // 1. Network token
      if (msg.token !== TOKEN) {
        console.log(`Auth rejected from ${clientIp} — bad network token`);
        ws.close(CLOSE.AUTH_REQUIRED, "bad token");
        return;
      }

      // 2. Agent name required
      if (!msg.agent || typeof msg.agent !== "string") {
        ws.close(CLOSE.AGENT_REQUIRED, "agent name required");
        return;
      }

      const name = msg.agent;
      const machine = msg.machine || `anon-${Date.now()}`;

      // 3. Agent uniqueness — same machine can replace, different machine rejected
      let replacing = false;
      if (agents.has(name)) {
        const existing = agents.get(name);
        if (existing.machine === machine) {
          replacing = true;
        } else {
          console.log(`Auth rejected — "${name}" already online (${existing.machine})`);
          ws.close(CLOSE.AGENT_TAKEN, `agent "${name}" already taken by ${existing.machine}`);
          return;
        }
      }

      // 4. Network agent limit (skip if replacing — count stays the same)
      if (!replacing && agents.size >= MAX_AGENTS) {
        console.log(`Auth rejected — network full (${agents.size}/${MAX_AGENTS})`);
        ws.close(CLOSE.NETWORK_FULL, `network full (${MAX_AGENTS} agents max)`);
        return;
      }

      // 5. Validate team tokens
      const teamEntries = msg.teams && typeof msg.teams === "object"
        ? Object.entries(msg.teams) : [];
      const agentTeams = new Set();

      for (const [teamName, teamToken] of teamEntries) {
        if (teams.has(teamName)) {
          const team = teams.get(teamName);
          // Token must match
          if (team.token !== teamToken) {
            console.log(`Auth rejected — bad token for team "${teamName}"`);
            ws.close(CLOSE.BAD_TEAM_TOKEN, `invalid token for team "${teamName}"`);
            return;
          }
          // Per-team limit (adjust -1 if this agent is already in the team from old connection)
          const effective = team.agents.has(name)
            ? team.agents.size - 1
            : team.agents.size;
          if (effective >= MAX_PER_TEAM) {
            console.log(`Auth rejected — team "${teamName}" full (${team.agents.size}/${MAX_PER_TEAM})`);
            ws.close(CLOSE.TEAM_FULL, `team "${teamName}" is full (${MAX_PER_TEAM} agents max)`);
            return;
          }
        } else {
          // New team — check total team limit
          if (teams.size >= MAX_TEAMS) {
            console.log(`Auth rejected — too many teams (${teams.size}/${MAX_TEAMS})`);
            ws.close(CLOSE.TOO_MANY_TEAMS, `too many teams (${MAX_TEAMS} max)`);
            return;
          }
        }
        agentTeams.add(teamName);
      }

      // ── All valid — replace old connection, register new ─────────

      if (replacing) {
        const old = agents.get(name);
        old.ws.close(CLOSE.REPLACED, "replaced");
        unregisterAgent(name);
      }

      // Create teams that don't exist yet
      for (const [teamName, teamToken] of teamEntries) {
        if (!teams.has(teamName)) {
          teams.set(teamName, { token: teamToken, agents: new Set() });
          console.log(`Team "${teamName}" created by "${name}"`);
        }
        teams.get(teamName).agents.add(name);
      }

      authenticated = true;
      agentName = name;
      agents.set(name, { machine, ws, teams: agentTeams });
      clearTimeout(authTimer);

      // ── Welcome ─────────────────────────────────────────────────

      const teamInfo = {};
      for (const tName of agentTeams) {
        const t = teams.get(tName);
        teamInfo[tName] = {
          agents: [...t.agents],
          active: t.agents.size,
        };
      }

      send(ws, {
        type: "welcome",
        agent: name,
        network: {
          totalAgents: agents.size,
          maxAgents: MAX_AGENTS,
          totalTeams: teams.size,
          maxTeams: MAX_TEAMS,
          maxPerTeam: MAX_PER_TEAM,
        },
        teams: teamInfo,
        allAgents: [...agents.keys()],
      });

      // ── Broadcast presence ──────────────────────────────────────

      broadcast({
        type: "agent_online",
        agent: name,
        machine,
        teams: [...agentTeams],
      }, ws);

      const teamList = [...agentTeams].map(t => `#${t}`).join(", ") || "none";
      console.log(
        `Agent "${name}" online (${machine}) from ${clientIp}. ` +
        `Teams: ${teamList}. ` +
        `Network: ${agents.size}/${MAX_AGENTS} agents, ${teams.size}/${MAX_TEAMS} teams`
      );
      return;
    }

    // ── Ping ─────────────────────────────────────────────────────

    if (msg.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }

    // ── Data: fan out to all other agents ────────────────────────

    if (msg.type === "append" || msg.type === "write") {
      const agent = agents.get(agentName);
      const fwd = { ...msg, from: agent?.machine || agentName };
      broadcast(fwd, ws);
      return;
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────

  ws.on("close", (code) => {
    clearTimeout(authTimer);
    if (agentName && agents.has(agentName)) {
      unregisterAgent(agentName);
      console.log(
        `Agent "${agentName}" disconnected (code ${code}). ` +
        `Network: ${agents.size}/${MAX_AGENTS} agents, ${teams.size}/${MAX_TEAMS} teams`
      );
    }
  });

  ws.on("error", () => { /* close handler cleans up */ });
});

// =============================================================================
// Unregister agent — remove from agents map, clean up teams
// =============================================================================

function unregisterAgent(name) {
  const agent = agents.get(name);
  if (!agent) return;

  agents.delete(name);

  const leftTeams = [];
  for (const teamName of agent.teams) {
    const team = teams.get(teamName);
    if (team) {
      team.agents.delete(name);
      leftTeams.push(teamName);
      if (team.agents.size === 0) {
        teams.delete(teamName);
        console.log(`Team "${teamName}" dissolved (no members)`);
      }
    }
  }

  broadcast({ type: "agent_offline", agent: name, teams: leftTeams });
}

// =============================================================================
// Helpers
// =============================================================================

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* transitional state */ }
  }
}

function broadcast(msg, exclude) {
  const raw = JSON.stringify(msg);
  for (const [, { ws }] of agents) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      try { ws.send(raw); } catch { /* transitional state */ }
    }
  }
}

// =============================================================================
// Heartbeat — detect dead connections
// =============================================================================

const heartbeat = setInterval(() => {
  for (const [name, { ws }] of agents) {
    if (!ws.isAlive) {
      console.log(`Agent "${name}" failed heartbeat`);
      ws.close(CLOSE.HEARTBEAT, "heartbeat timeout");
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// =============================================================================
// Stats
// =============================================================================

setInterval(() => {
  if (agents.size > 0) {
    const teamSummary = [...teams.entries()]
      .map(([name, data]) => `${name}(${data.agents.size}/${MAX_PER_TEAM})`)
      .join(", ");
    console.log(
      `[${agents.size}/${MAX_AGENTS} agents] ` +
      `[${teams.size}/${MAX_TEAMS} teams: ${teamSummary || "none"}]`
    );
  }
}, 60000).unref();
