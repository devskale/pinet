#!/usr/bin/env node
/**
 * PiNet Sync Daemon v2
 *
 * Bridges ~/.pinet/ filesystem ↔ WebSocket relay.
 * Uses polling (every 2s) for reliable change detection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocket } from "ws";

const PINET_DIR = path.join(process.env.HOME || "~", ".pinet");
const RELAY_CONFIG = path.join(PINET_DIR, "relay.json");

// Allow override: PINET_AGENT_NAME=BackendDev node sync.js
const AGENT_OVERRIDE = process.env.PINET_AGENT_NAME || null;

if (!AGENT_OVERRIDE) {
  console.error("PINET_AGENT_NAME env var required. Started by the extension — not standalone.");
  process.exit(1);
}

// =============================================================================
// State
// =============================================================================

let config = null;
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;
const POLL_MS = 2000;

// Track line counts per file to detect new lines
let fileLineCounts = new Map();
let snapshotFiles = new Set();

// Timestamp of last remote write per file (to skip syncing our own writes)
let remoteWriteTime = new Map();

// File list cache — rescan directories every RESCAN_MS instead of every poll
const RESCAN_MS = 30000;
let cachedFiles = [];
let lastRescanTime = 0;

// =============================================================================
// Helpers
// =============================================================================

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content ? content.split("\n").filter((l) => l.trim()) : [];
}

function lineCount(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content ? content.split("\n").length : 0;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Recursively find all .jsonl and .json files under PINET_DIR
function findAllFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json")) {
      results.push(fullPath);
    }
  }
  return results;
}

// =============================================================================
// WebSocket connection
// =============================================================================

function connect() {
  if (!config) {
    console.error("No relay config");
    process.exit(1);
  }

  console.log(`Connecting to ${config.url}...`);
  try {
    ws = new WebSocket(config.url);
  } catch (err) {
    console.error(`Connection failed: ${err.message}`);
    reconnect();
    return;
  }

  ws.on("open", () => {
    console.log("WebSocket opened, authenticating...");
    ws.send(JSON.stringify({
      type: "auth",
      token: config.token,
      machine: config.machine,
      agent: AGENT_OVERRIDE || config.agent || config.machine,
      teams: config.teams || {},
    }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "welcome") {
      console.log(`Connected as ${msg.agent}. Network: ${msg.network?.totalAgents || "?"}/${msg.network?.maxAgents || "?"} agents`);
      reconnectAttempts = 0;
      onConnected();
      return;
    }

    if (msg.type === "append" || msg.type === "write") {
      handleRemoteChange(msg);
      return;
    }

    if (msg.type === "pong") return;

    if (msg.type === "agent_online") {
      console.log(`🟢 ${msg.agent} joined (${msg.machine})`);
      return;
    }

    if (msg.type === "agent_offline") {
      console.log(`🔴 ${msg.agent} left`);
      return;
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`Disconnected: ${code} ${reason || ""}`);
    reconnect();
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error: ${err.message}`);
    reconnect();
  });

  ws.on("ping", () => ws.pong());
}

function reconnect() {
  const delay = Math.min(MAX_RECONNECT_DELAY, 500 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  console.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
  setTimeout(connect, delay);
}

// =============================================================================
// After connected — snapshot current state, start polling
// =============================================================================

function onConnected() {
  // Snapshot all current file line counts
  cachedFiles = findAllFiles(PINET_DIR);
  lastRescanTime = Date.now();
  snapshotFiles = new Set(cachedFiles);
  for (const f of cachedFiles) {
    fileLineCounts.set(f, lineCount(f));
  }
  console.log(`Snapshot: ${cachedFiles.length} files tracked`);

  // Start polling
  startPolling();
}

// =============================================================================
// Polling — scan for changes every POLL_MS
// =============================================================================

let pollTimer = null;

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
  console.log(`Polling every ${POLL_MS / 1000}s`);
}

function poll() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Rescan file list periodically (new teams, new mailboxes)
  const now = Date.now();
  if (now - lastRescanTime >= RESCAN_MS) {
    cachedFiles = findAllFiles(PINET_DIR);
    lastRescanTime = now;
  }

  for (const filePath of cachedFiles) {
    // Skip if we just wrote this file from a remote change (within last 3 seconds)
    const lastRemote = remoteWriteTime.get(filePath) || 0;
    if (Date.now() - lastRemote < 3000) continue;

    const currentLines = lineCount(filePath);
    // New files (not in snapshot) start at 0 so we sync all their lines
    const previousCount = fileLineCounts.has(filePath)
      ? fileLineCounts.get(filePath)
      : (snapshotFiles.has(filePath) ? currentLines : 0);

    if (currentLines > previousCount) {
      // New lines found!
      const allLines = readJsonl(filePath);
      const newLines = allLines.slice(previousCount);

      // Only sync our own messages — other agents' messages come via relay
      const myAgent = AGENT_OVERRIDE || config.agent || config.machine;
      const ownLines = newLines.filter(l => {
        try {
          const obj = typeof l === "string" ? JSON.parse(l) : l;
          return obj.from === myAgent;
        } catch { return true; }
      });

      if (ownLines.length > 0) {
        const relativePath = path.relative(PINET_DIR, filePath);
        fileLineCounts.set(filePath, currentLines);

        ws.send(JSON.stringify({
          type: "append",
          from: config.machine,
          path: relativePath,
          lines: ownLines,
        }));

        console.log(`↑ Synced ${ownLines.length} line(s): ${relativePath}`);
      } else {
        // Still advance the line count so we don't re-read these
        fileLineCounts.set(filePath, currentLines);
      }
    } else {
      // Update count even if no change (file might have been replaced)
      fileLineCounts.set(filePath, currentLines);
    }
  }
}

// =============================================================================
// Remote changes (relay → local)
// =============================================================================

function handleRemoteChange(msg) {
  if (!config) return;

  // Skip our own writes bouncing back through the relay
  const myAgent = AGENT_OVERRIDE || config.agent || config.machine;
  if (msg.agent === myAgent) return;

  // Same-machine agents share the filesystem — don't write duplicate lines.
  // Just advance our line counter and deliver via IPC.
  const sameMachine = msg.from === config.machine;

  const filePath = path.join(PINET_DIR, msg.path);
  ensureDir(path.dirname(filePath));

  // Track new files in cache immediately
  if (!cachedFiles.includes(filePath)) {
    cachedFiles.push(filePath);
  }

  try {
    if (msg.type === "append" && msg.lines) {
      if (sameMachine) {
        // File already has these lines — just advance our counter
        const newCount = lineCount(filePath);
        fileLineCounts.set(filePath, newCount);
      } else {
        // Cross-machine: write to local file
        remoteWriteTime.set(filePath, Date.now());
        const lines = msg.lines.map(l => typeof l === "string" ? l : JSON.stringify(l));
        fs.appendFileSync(filePath, lines.join("\n") + "\n");
        const newCount = lineCount(filePath);
        fileLineCounts.set(filePath, newCount);
      }
      // Always deliver via IPC so the pi agent sees the message
      try { process.send({ type: "pinet-deliver", channel: "team", path: msg.path, from: msg.from, agent: msg.agent, lines: msg.lines }); } catch { /* parent gone */ }

      console.log(`↓ Received ${msg.lines.length} line(s): ${msg.path} (from ${msg.from}${sameMachine ? ", same-machine" : ""})`);
    } else if (msg.type === "write" && msg.content != null) {
      if (!sameMachine) {
        remoteWriteTime.set(filePath, Date.now());
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        fs.writeFileSync(filePath, content);
      }
      try { process.send({ type: "pinet-deliver", channel: "write", path: msg.path, from: msg.from, agent: msg.agent, content: msg.content }); } catch { /* parent gone */ }

      console.log(`↓ Received write: ${msg.path} (from ${msg.from}${sameMachine ? ", same-machine" : ""})`);
    }
  } catch (err) {
    console.error(`Write error for ${msg.path}: ${err.message}`);
  }
}

// =============================================================================
// Heartbeat
// =============================================================================

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 30000);

// =============================================================================
// Main
// =============================================================================

function main() {
  config = readJson(RELAY_CONFIG);
  if (!config) {
    console.error("No relay.json found at ~/.pinet/relay.json");
    process.exit(1);
  }

  console.log(`PiNet sync daemon v2 starting`);
  console.log(`  Machine: ${config.machine}`);
  console.log(`  Agent: ${config.agent || config.machine}`);
  console.log(`  Relay: ${config.url}`);

  connect();
}

main();
