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
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

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
const MAX_BUFFER_PER_CHANNEL = 200;

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

// ── Message buffers (ring) for browser API ────────────────────────────────

/** teamName → Message[] (max MAX_BUFFER_PER_CHANNEL) */
const teamBuffers = new Map();

/** agentName → Message[] (max MAX_BUFFER_PER_CHANNEL) — DM mailbox */
const dmBuffers = new Map();

/** projectName → { name, agents, teams, relayUrl, machine, created } */
const projects = new Map();

function bufferPush(map, key, msg) {
  if (!map.has(key)) map.set(key, []);
  const buf = map.get(key);
  buf.push(msg);
  if (buf.length > MAX_BUFFER_PER_CHANNEL) buf.splice(0, buf.length - MAX_BUFFER_PER_CHANNEL);
}

// =============================================================================
// Seed demo project
// =============================================================================

const DEMO_PROJECT = process.env.PINET_DEMO === '1';
if (DEMO_PROJECT && !projects.has('demo')) {
  const demoToken = crypto.randomBytes(8).toString('hex');
  projects.set('demo', {
    name: 'demo',
    agents: [
      { name: 'Master', model: 'claude-sonnet-4', role: 'Coordinator — decomposes tasks and manages the team', teams: ['build'], machine: '' },
      { name: 'FrontendDev', model: '', role: 'Frontend developer', teams: ['build'], machine: '' },
      { name: 'BackendDev', model: '', role: 'Backend developer', teams: ['build'], machine: '' },
      { name: 'Tester', model: 'glm-4.7', role: 'QA — validates features and reports bugs', teams: ['build'], machine: '' },
    ],
    teams: [{ name: 'build', token: demoToken }],
    relayUrl: '',
    machine: '',
    created: new Date().toISOString(),
  });
  console.log('Demo project seeded (team token: ' + demoToken + ')');
}

// =============================================================================
// Server
// =============================================================================

const startedAt = new Date().toISOString();

// =============================================================================
// HTTP handler — dashboard + stats API
// =============================================================================

const http = require("http");
const https = require("https");

const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf-8");

const URL = require("url");

function handleHttpRequest(req, res) {
  const parsed = URL.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // ── CORS preflight ───────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  // ── Auth helper ──────────────────────────────────────────────────────
  function checkToken() {
    // Token from: ?token=... OR Authorization: Bearer ...
    const t = query.token || (req.headers.authorization && req.headers.authorization.replace("Bearer ", ""));
    if (t !== TOKEN) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return false;
    }
    return true;
  }

  // ── /api/stats ───────────────────────────────────────────────────────
  if (pathname === "/api/stats") {
    res.writeHead(200, headers);
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

  // ── /api/messages/<team> ─────────────────────────────────────────────
  const messagesMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (messagesMatch) {
    if (!checkToken()) return;
    const teamName = decodeURIComponent(messagesMatch[1]);
    const limit = Math.min(parseInt(query.limit, 10) || 50, 200);
    const before = query.before; // ISO timestamp — return messages before this

    if (!teams.has(teamName)) {
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: `team "${teamName}" not found` }));
      return;
    }

    let messages = teamBuffers.get(teamName) || [];
    if (before) messages = messages.filter(m => m.timestamp < before);
    messages = messages.slice(-limit);

    res.writeHead(200, headers);
    res.end(JSON.stringify({
      team: teamName,
      members: [...teams.get(teamName).agents],
      count: messages.length,
      messages,
    }));
    return;
  }

  // ── /api/mailbox/<agent> ─────────────────────────────────────────────
  const mailboxMatch = pathname.match(/^\/api\/mailbox\/([^/]+)$/);
  if (mailboxMatch) {
    if (!checkToken()) return;
    const agentName = decodeURIComponent(mailboxMatch[1]);
    const limit = Math.min(parseInt(query.limit, 10) || 50, 200);
    const before = query.before;

    let messages = dmBuffers.get(agentName) || [];
    if (before) messages = messages.filter(m => m.timestamp < before);
    messages = messages.slice(-limit);

    res.writeHead(200, headers);
    res.end(JSON.stringify({
      agent: agentName,
      count: messages.length,
      messages,
    }));
    return;
  }

  // ── /api/conversations ──────────────────────────────────────────────
  if (pathname === "/api/conversations") {
    if (!checkToken()) return;
    const convTeams = [];
    for (const [name, data] of teams) {
      const buf = teamBuffers.get(name) || [];
      const last = buf.length ? buf[buf.length - 1] : null;
      convTeams.push({
        type: "team",
        name,
        members: [...data.agents],
        max: MAX_PER_TEAM,
        lastMessage: last ? { from: last.from, body: last.body, timestamp: last.timestamp } : null,
        messageCount: buf.length,
      });
    }
    const convDms = [];
    for (const [agentName, buf] of dmBuffers) {
      const last = buf.length ? buf[buf.length - 1] : null;
      convDms.push({
        type: "dm",
        agent: agentName,
        lastMessage: last ? { from: last.from, body: last.body, timestamp: last.timestamp } : null,
        messageCount: buf.length,
      });
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ teams: convTeams, dms: convDms }));
    return;
  }

  // ── /api/projects — list all projects ───────────────────────────────
  if (pathname === '/api/projects' && req.method === 'GET') {
    if (!checkToken()) return;
    const list = [...projects.entries()].map(([name, data]) => ({
      name,
      agents: data.agents,
      teams: data.teams,
      relayUrl: data.relayUrl,
      machine: data.machine,
      created: data.created,
    }));
    res.writeHead(200, headers);
    res.end(JSON.stringify({ projects: list }));
    return;
  }

  // ── POST /api/projects — create a project ───────────────────────────
  if (pathname === '/api/projects' && req.method === 'POST') {
    if (!checkToken()) return;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        const name = (p.name || '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!name) { res.writeHead(400, headers); res.end(JSON.stringify({ error: 'name required' })); return; }
        if (projects.has(name)) { res.writeHead(409, headers); res.end(JSON.stringify({ error: 'project already exists' })); return; }

        const project = {
          name,
          agents: (p.agents || []).map(a => ({
            name: a.name || 'Agent',
            model: a.model || '',
            role: a.role || '',
            teams: a.teams || [],
            machine: a.machine || '',
          })),
          teams: (p.teams || []).map(t => ({
            name: t.name || 'team',
            token: t.token || crypto.randomBytes(8).toString('hex'),
          })),
          relayUrl: p.relayUrl || '',
          machine: p.machine || '',
          created: new Date().toISOString(),
        };
        projects.set(name, project);
        res.writeHead(201, headers);
        res.end(JSON.stringify(project));
      } catch (e) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  // ── DELETE /api/projects/<name> ─────────────────────────────────────
  const deleteProjectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (deleteProjectMatch && req.method === 'DELETE') {
    if (!checkToken()) return;
    const pName = decodeURIComponent(deleteProjectMatch[1]);
    if (!projects.has(pName)) { res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' })); return; }
    projects.delete(pName);
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── /api/projects/<name>/setup — generate setup instructions ────────
  const setupMatch = pathname.match(/^\/api\/projects\/([^/]+)\/setup$/);
  if (setupMatch) {
    if (!checkToken()) return;
    const pName = decodeURIComponent(setupMatch[1]);
    const project = projects.get(pName);
    if (!project) { res.writeHead(404, headers); res.end(JSON.stringify({ error: 'project not found' })); return; }

    const relayUrl = project.relayUrl || (req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws') + '://' + (req.headers.host || 'localhost:7654').replace(/:[0-9]+$/, ':' + PORT);
    const machine = project.machine || os.hostname().split('.')[0] || 'agent';
    const teamTokenMap = {};
    for (const t of project.teams) teamTokenMap[t.name] = t.token;

    const instructions = project.agents.map(agent => {
      const teamParts = agent.teams.map(t => {
        const tok = teamTokenMap[t] || '';
        return tok ? `${t}:${tok}` : t;
      });
      const teamLogin = teamParts.length > 0 ? '@' + teamParts.join(',') : '';
      const wizardTeams = teamParts.length > 0 ? ' ' + teamParts.join(' ') : '';
      const wizardCmd = `/pinet wizard ${relayUrl} ${TOKEN} ${machine}${wizardTeams}`;
      const loginCmd = `/pinet ${agent.name}${teamLogin}`;

      return {
        agent: agent.name,
        role: agent.role,
        model: agent.model,
        teams: agent.teams,
        machine: agent.machine,
        commands: [wizardCmd, loginCmd].join('\n'),
      };
    });

    res.writeHead(200, headers);
    res.end(JSON.stringify({ project: pName, instructions }));
    return;
  }

  // ── Dashboard (fallback) ─────────────────────────────────────────────
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache, no-store, must-revalidate" });
  let html = DASHBOARD_HTML;
  if (DEMO_PROJECT) {
    html = html.replace('</body>', '<script>TOKEN="' + TOKEN + '";sessionStorage.setItem("pinet-token",TOKEN);doLogin();</script></body>');
  }
  res.end(html);
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
  ? new WebSocket.Server({ server: httpServer, maxPayload: 64 * 1024 })
  : new WebSocket.Server({ port: PORT, maxPayload: 64 * 1024 });

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

      // Buffer for message browser API
      if (msg.type === "append" && msg.lines) {
        const relPath = msg.path || "";
        const ts = new Date().toISOString();

        // Team messages: path starts with "teams/<name>/"
        const teamMatch = relPath.match(/^teams\/([^/]+)\//);
        if (teamMatch) {
          const teamName = teamMatch[1];
          for (const line of msg.lines) {
            let parsed;
            try { parsed = typeof line === "string" ? JSON.parse(line) : line; } catch { parsed = line; }
            bufferPush(teamBuffers, teamName, {
              from: agentName,
              team: teamName,
              body: parsed?.body || parsed?.text || (typeof parsed === "string" ? parsed : JSON.stringify(parsed)),
              timestamp: parsed?.timestamp || ts,
              machine: agent?.machine || agentName,
            });
          }
        }

        // DMs: path starts with "mailboxes/<name>."
        const dmMatch = relPath.match(/^mailboxes\/([^./]+)/);
        if (dmMatch) {
          const recipient = dmMatch[1];
          for (const line of msg.lines) {
            let parsed;
            try { parsed = typeof line === "string" ? JSON.parse(line) : line; } catch { parsed = line; }
            bufferPush(dmBuffers, recipient, {
              from: agentName,
              to: recipient,
              body: parsed?.body || parsed?.text || (typeof parsed === "string" ? parsed : JSON.stringify(parsed)),
              timestamp: parsed?.timestamp || ts,
              machine: agent?.machine || agentName,
            });
          }
        }
      }

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
