#!/usr/bin/env node
/**
 * PiNet Sync Daemon v2
 *
 * Bridges ~/.pinet/ filesystem ↔ WebSocket relay.
 * Uses polling (every 2s) for reliable change detection.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";

const PINET_DIR = process.env.PINET_DIR || path.join(os.homedir(), ".pinet");
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

// Cursor of the last-synced line per file: { ts, id } (ISO timestamp + unique id).
// A line is "new" iff its (ts,id) is strictly greater than the cursor. This is
// immune to compaction, which only ever drops the head (older lines).
let fileCursors = new Map();
let snapshotFiles = new Set();

// Timestamp of last remote write per file (to skip syncing our own writes)
let remoteWriteTime = new Map();

// File list cache — rescan directories every RESCAN_MS instead of every poll
const RESCAN_MS = 30000;
let cachedFiles = [];
let cachedFilesSet = new Set();
let lastRescanTime = 0;

// =============================================================================
// Helpers
// =============================================================================

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/** Read and parse every JSONL line in a file. Malformed lines are dropped. */
function readParsed(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  const out = [];
  for (const l of content.split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* malformed line — skip */ }
  }
  return out;
}

/** Ordering key for a parsed line: (timestamp, id). Both message shapes
 *  (PersonalMessage / TeamMessage) carry these; falls back to created/lastSeen
 *  for non-message logs (e.g. identities.jsonl). */
function cursorOf(obj) {
  if (!obj || typeof obj !== "object") return { ts: "", id: "" };
  return {
    ts: String(obj.timestamp || obj.created || obj.lastSeen || ""),
    id: String(obj.id || ""),
  };
}

/** Lexicographic (ts, id) comparison. Compaction-safe: a line counts as new
 *  iff its key is strictly greater than the cursor, no matter how many head
 *  lines were removed. */
function compareCursor(a, b) {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Cursor of the last parsed line in a file, or null if the file is empty. */
function lastLineCursor(filePath) {
  const lines = readParsed(filePath);
  return lines.length ? cursorOf(lines[lines.length - 1]) : null;
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
  // Snapshot: cursor = last line of each existing file, so pre-existing
  // history isn't re-synced on connect.
  cachedFiles = findAllFiles(PINET_DIR);
  cachedFilesSet = new Set(cachedFiles);
  lastRescanTime = Date.now();
  snapshotFiles = new Set(cachedFiles);
  for (const f of cachedFiles) {
    fileCursors.set(f, lastLineCursor(f));
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
    cachedFilesSet = new Set(cachedFiles);
    lastRescanTime = now;
  }

  const myAgent = AGENT_OVERRIDE || config.agent || config.machine;

  for (const filePath of cachedFiles) {
    // Skip if we just wrote this file from a remote change (within last 3 seconds)
    const lastRemote = remoteWriteTime.get(filePath) || 0;
    if (Date.now() - lastRemote < 3000) continue;

    const lines = readParsed(filePath);
    const lastCursor = lines.length ? cursorOf(lines[lines.length - 1]) : null;

    // First sight after snapshot of a brand-new file → sync from line 0.
    // (Files present at snapshot already had their cursor set in onConnected.)
    if (!fileCursors.has(filePath) && !snapshotFiles.has(filePath)) {
      fileCursors.set(filePath, null);
    }
    const cursor = fileCursors.get(filePath);

    // Lines strictly newer than the cursor. Compaction-safe: even if the
    // cursor line itself was dropped from the head, every surviving newer
    // line still compares greater.
    const newLines = cursor
      ? lines.filter((l) => compareCursor(cursorOf(l), cursor) > 0)
      : lines;

    // Only sync our own messages — other agents' messages come via relay
    const ownLines = newLines.filter((l) => l && l.from === myAgent);

    if (ownLines.length > 0) {
      const relativePath = path.relative(PINET_DIR, filePath).split(path.sep).join("/");
      ws.send(JSON.stringify({
        type: "append",
        from: config.machine,
        path: relativePath,
        lines: ownLines.map((l) => JSON.stringify(l)),
      }));
      console.log(`↑ Synced ${ownLines.length} line(s): ${relativePath}`);
    }

    // Always advance the cursor to the last line so we don't rescan.
    if (lastCursor) fileCursors.set(filePath, lastCursor);
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
  if (!cachedFilesSet.has(filePath)) {
    cachedFiles.push(filePath);
    cachedFilesSet.add(filePath);
  }

  try {
    if (msg.type === "append" && msg.lines) {
      if (sameMachine) {
        // File already has these lines — just advance our cursor past them.
        const lc = lastLineCursor(filePath);
        if (lc) fileCursors.set(filePath, lc);
      } else {
        // Cross-machine: write to local file
        remoteWriteTime.set(filePath, Date.now());
        const lines = msg.lines.map(l => typeof l === "string" ? l : JSON.stringify(l));
        fs.appendFileSync(filePath, lines.join("\n") + "\n");
        const lc = lastLineCursor(filePath);
        if (lc) fileCursors.set(filePath, lc);
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
