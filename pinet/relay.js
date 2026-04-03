#!/usr/bin/env node
/**
 * PiNet Relay — WebSocket fan-out for cross-machine sync.
 *
 * Usage:
 *   node relay.js --port 3000 --token my-secret
 *
 * The relay is a dumb pipe. It doesn't understand PiNet semantics.
 * It authenticates connections by token, then fans out file changes
 * to all other connected machines in the same network.
 *
 * Protocol (see docs/crossmachine.md):
 *   Client → Relay: auth, append, write, ping
 *   Relay → Client: append, write, pong, join, leave, welcome
 */

const { parseArgs } = require("node:util");

// =============================================================================
// CLI
// =============================================================================

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3000" },
    token: { type: "string" },
    "heartbeat-ms": { type: "string", default: "30000" },
    "auth-timeout-ms": { type: "string", default: "5000" },
  },
  strict: true,
});

if (!values.token) {
  console.error("Usage: node relay.js --port 3000 --token <secret>");
  console.error("  --token is required");
  process.exit(1);
}

const PORT = parseInt(values.port, 10);
const TOKEN = values.token;
const HEARTBEAT_MS = parseInt(values["heartbeat-ms"], 10);
const AUTH_TIMEOUT_MS = parseInt(values["auth-timeout-ms"], 10);

// =============================================================================
// WebSocket server (zero dependencies beyond 'ws')
// =============================================================================

let WebSocket;
try {
  WebSocket = require("ws");
} catch {
  console.error("'ws' package not found. Install it:");
  console.error("  npm install ws");
  process.exit(1);
}

const machines = new Map(); // machineId → { ws, alive }

const wss = new WebSocket.Server({ port: PORT });

wss.on("listening", () => {
  console.log(`PiNet relay listening on :${PORT}`);
  console.log(`Heartbeat: every ${HEARTBEAT_MS / 1000}s`);
  console.log(`Auth timeout: ${AUTH_TIMEOUT_MS / 1000}s`);
  console.log(`Ready. Waiting for connections.`);
});

wss.on("connection", (ws, req) => {
  let authenticated = false;
  let machineId = null;
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // Auth timeout
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      ws.close(4001, "auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  // Heartbeat
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      ws.close(4000, "invalid json");
      return;
    }

    // ── Auth ────────────────────────────────────
    if (!authenticated) {
      if (msg.type !== "auth") {
        ws.close(4001, "auth required");
        return;
      }
      if (msg.token !== TOKEN) {
        console.log(`Auth rejected from ${clientIp} — bad token`);
        ws.close(4001, "bad token");
        return;
      }
      const id = msg.machine || msg.machineId || `anon-${Date.now()}`;

      // Kick existing connection with same machine ID
      if (machines.has(id)) {
        const old = machines.get(id);
        console.log(`Replacing connection for machine "${id}"`);
        old.ws.close(4002, "replaced by new connection");
      }

      authenticated = true;
      machineId = id;
      machines.set(machineId, { ws, alive: true });
      clearTimeout(authTimer);

      // Welcome
      const peerList = [...machines.keys()].filter((k) => k !== machineId);
      send(ws, { type: "welcome", machines: peerList });

      // Notify peers
      broadcast({ type: "join", machine: machineId }, ws);

      console.log(`Machine "${machineId}" connected from ${clientIp}. Peers: ${peerList.length}`);
      return;
    }

    // ── Ping ───────────────────────────────────
    if (msg.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }

    // ── Data: fan out ──────────────────────────
    if (msg.type === "append" || msg.type === "write") {
      const fwd = { ...msg, from: machineId };
      broadcast(fwd, ws);
      return;
    }
  });

  ws.on("close", (code, reason) => {
    clearTimeout(authTimer);
    if (machineId && machines.has(machineId)) {
      machines.delete(machineId);
      broadcast({ type: "leave", machine: machineId });
      console.log(`Machine "${machineId}" disconnected (code ${code}).`);
    }
  });

  ws.on("error", (err) => {
    // Ignore — close handler will clean up
  });
});

// =============================================================================
// Helpers
// =============================================================================

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg, exclude) {
  const raw = JSON.stringify(msg);
  let count = 0;
  for (const [id, { ws }] of machines) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
      count++;
    }
  }
  return count;
}

// =============================================================================
// Heartbeat: detect dead connections
// =============================================================================

const heartbeat = setInterval(() => {
  for (const [id, { ws }] of machines) {
    if (!ws.isAlive) {
      console.log(`Machine "${id}" failed heartbeat — closing`);
      ws.close(4003, "heartbeat timeout");
      // close handler will clean up machines map
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

heartbeat.unref(); // don't prevent process exit

// =============================================================================
// Stats
// =============================================================================

setInterval(() => {
  if (machines.size > 0) {
    console.log(`Connected: ${machines.size} machine${machines.size !== 1 ? "s" : ""} (${[...machines.keys()].join(", ")})`);
  }
}, 60000).unref();
