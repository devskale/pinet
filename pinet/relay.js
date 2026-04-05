#!/usr/bin/env node
/**
 * PiNet Relay — WebSocket fan-out for cross-machine agent sync.
 *
 * Usage:
 *   node relay.js --port 7654 --token-file relay-token
 *   node relay.js --port 7654 --token-file relay-token --tls-key key.pem --tls-cert cert.pem
 *
 * With TLS, WebSocket and dashboard share a single port (--port).
 * Without TLS, WebSocket uses --port, dashboard uses --http-port.
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
    "tls-key": { type: "string" },
    "tls-cert": { type: "string" },
  },
  strict: true,
});

const TOKEN = values["token-file"]
  ? fs.readFileSync(values["token-file"], "utf-8").trim()
  : values.token;

if (!TOKEN) {
  console.error("Usage: node relay.js --port 7654 --token <secret>");
  console.error("       node relay.js --port 7654 --token-file <path>");
  console.error("");
  console.error("TLS:");
  console.error("       node relay.js --port 7654 --token-file token --tls-key key.pem --tls-cert cert.pem");
  process.exit(1);
}

const PORT = parseInt(values.port, 10);
const HTTP_PORT = parseInt(values["http-port"], 10) || 8081;
const HEARTBEAT_MS = parseInt(values["heartbeat-ms"], 10);
const AUTH_TIMEOUT_MS = parseInt(values["auth-timeout-ms"], 10);
const TLS_KEY = values["tls-key"];
const TLS_CERT = values["tls-cert"];
const USE_TLS = !!(TLS_KEY && TLS_CERT);

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
// HTTP handler — dashboard + stats API
// =============================================================================

const http = require("http");
const https = require("https");

const DASHBOARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>pinet</title></head>
<body style="font-family:monospace;background:#000;color:#fff;padding:2rem;max-width:640px">
<pre id="out">loading...</pre>
<script>function fmt(ms){const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);return d?d+'d '+h%24+'h':h?h%24+'h '+m%60+'m':m+'m'}function refresh(){fetch('/api/stats').then(r=>r.json()).then(d=>{let o='pinet relay';o+='\\n  up '+fmt(d.uptime)+'  agents '+d.agents.length+'/'+d.maxAgents+'  teams '+d.teamList.length+'/'+d.maxTeams;o+='\\n';if(d.agents.length){o+='\\nagents';for(const a of d.agents)o+='\\n  '+a.name+'  '+a.machine+'  '+a.teams.map(t=>'#'+t).join(' ')}else o+='\\n  no agents';if(d.teamList.length){o+='\\n\\nteams';for(const t of d.teamList)o+='\\n  #'+t.name+'  '+t.members.join(', ')+'  ('+t.members.length+'/'+t.max+')'}else o+='\\n\\n  no teams';o+='\\n';document.getElementById('out').textContent=o}).catch(()=>{})}refresh();setInterval(refresh,5000);</script>
</body></html>`;

function handleHttpRequest(req, res) {
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
      teamList, maxTeams: MAX_TEAMS, tls: USE_TLS,
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache, no-store, must-revalidate" });
  res.end(DASHBOARD_HTML);
}

// =============================================================================
// Create servers (TLS or plain)
// =============================================================================

const tlsOptions = USE_TLS ? {
  key: fs.readFileSync(TLS_KEY),
  cert: fs.readFileSync(TLS_CERT),
} : null;

// With TLS: single server for both HTTP and WebSocket
// Without TLS: separate servers on separate ports
const httpServer = USE_TLS
  ? https.createServer(tlsOptions, handleHttpRequest)
  : http.createServer(handleHttpRequest);

const listenPort = USE_TLS ? PORT : HTTP_PORT;
const scheme = USE_TLS ? "https" : "http";

httpServer.listen(listenPort, () => {
  console.log(`Dashboard on ${scheme}://localhost:${listenPort}`);
});

const wss = USE_TLS
  ? new WebSocket.Server({ server: httpServer })
  : new WebSocket.Server({ port: PORT });

wss.on("listening", () => {
  const wsScheme = USE_TLS ? "wss" : "ws";
  const wsPort = USE_TLS ? PORT : PORT;
  console.log(`PiNet relay listening on ${wsScheme}://:${wsPort}${USE_TLS ? " (TLS)" : ""}`);
  if (USE_TLS) console.log(`TLS: key=${TLS_KEY} cert=${TLS_CERT}`);
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
      const fwd = { ...msg, from: agent?.machine || agentName, agent: agentName };
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
