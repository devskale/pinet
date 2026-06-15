#!/usr/bin/env node
/**
 * E2E: real sync.mjs daemons through a real relay.
 *
 * Spawns its own relay on a test port, forks two sync.mjs daemons with
 * isolated temp PINET_DIRs, and asserts:
 *   TEST 1 (sanity)  — a DM appended on machine A lands on machine B.
 *   TEST 2 (the bug) — delivery SURVIVES compaction. Seed A's mailbox at the
 *                      compaction steady-state (500 lines), then append+compact
 *                      one more; B must still receive exactly that new line.
 *
 * Run: node test/e2e-sync.js
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, fork } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const RELAY_JS = path.join(ROOT, "relay.js");
const SYNC_MJS = path.join(ROOT, "sync.mjs");

const RELAY_PORT = 17699;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const TOKEN = "e2e-token";
const POLL_MS = 2000;          // sync.mjs poll interval
const SETTLE_MS = POLL_MS + 2500;
const MAX_JSONL_LINES = 500;   // types.ts

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let relay = null;

function cleanup() {
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  if (relay) { try { relay.kill("SIGKILL"); } catch {} }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

// ── helpers ──────────────────────────────────────────────────────────────
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "pinet-e2e-")); }

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function compact(file, max = MAX_JSONL_LINES) {
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
  if (lines.length <= max) return 0;
  const kept = lines.slice(-max);
  const tmp = file + ".tmp." + crypto.randomUUID();
  fs.writeFileSync(tmp, kept.join("\n") + "\n");
  fs.renameSync(tmp, file);
  return lines.length - kept.length;
}

function waitFor(file, predicate, timeoutMs = 15000, stepMs = 250) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      try {
        if (predicate(readJsonl(file))) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting on ${file}`));
      setTimeout(check, stepMs);
    })();
  });
}

// ── relay ────────────────────────────────────────────────────────────────
function startRelay() {
  return new Promise((resolve, reject) => {
    relay = spawn("node", [RELAY_JS, "--port", RELAY_PORT, "--http-port", RELAY_PORT + 1, "--token", TOKEN], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(relay);
    relay.stdout.on("data", (d) => {
      if (d.toString().includes("Ready.")) resolve();
    });
    relay.stderr.on("data", (d) => process.stderr.write(`[relay] ${d}`));
    relay.on("exit", (code) => reject(new Error(`relay exited early code=${code}`)));
    setTimeout(() => reject(new Error("relay start timeout")), 8000);
  });
}

// ── daemon ───────────────────────────────────────────────────────────────
function forkDaemon(pinetDir, agent, machine) {
  fs.mkdirSync(pinetDir, { recursive: true });
  fs.writeFileSync(
    path.join(pinetDir, "relay.json"),
    JSON.stringify({ url: RELAY_URL, token: TOKEN, machine }, null, 2)
  );
  const child = fork(SYNC_MJS, [], {
    env: { ...process.env, PINET_DIR: pinetDir, PINET_AGENT_NAME: agent },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  // Buffer ALL stdout from fork time so connect-detection can't race an
  // event that fires before a listener is attached.
  child._buf = "";
  child.stdout.on("data", (d) => {
    const s = d.toString();
    child._buf += s;
    process.stdout.write(`[${agent}] ${s}`);
  });
  child.stderr.on("data", (d) => process.stderr.write(`[${agent}!] ${d}`));
  return child;
}

function waitForConnect(child, agent, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      if (child._buf && child._buf.includes("Snapshot:")) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`${agent} connect timeout`));
      setTimeout(check, 100);
    })();
  });
}

// ── main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log("starting relay...");
  await startRelay();
  console.log("relay ready.");

  const dirA = tmpDir();
  const dirB = tmpDir();

  // Pre-seed A's Bob mailbox at the compaction steady-state (500 lines),
  // BEFORE A connects, so A's snapshot cursor lands on the 500th line.
  const mailboxA = path.join(dirA, "mailboxes", "Bob.mailbox.jsonl");
  for (let i = 0; i < MAX_JSONL_LINES; i++) {
    appendJsonl(mailboxA, { id: `old-${i}`, from: "Alice", to: "Bob", body: `seed ${i}`, timestamp: new Date(Date.now() - (MAX_JSONL_LINES - i) * 1000).toISOString() });
  }
  // Pre-create an EMPTY Charlie mailbox so it's in A's snapshot file list
  // (new files aren't picked up until the 30s rescan otherwise).
  const sanitySrc = path.join(dirA, "mailboxes", "Charlie.mailbox.jsonl");
  fs.mkdirSync(path.dirname(sanitySrc), { recursive: true });
  fs.writeFileSync(sanitySrc, "");
  console.log(`seeded A's Bob mailbox with ${MAX_JSONL_LINES} lines + empty Charlie mailbox (pre-connect)`);

  // Fork both daemons.
  const daemonA = forkDaemon(dirA, "Alice", "machineA");
  const daemonB = forkDaemon(dirB, "Bob", "machineB");
  await waitForConnect(daemonA, "Alice");
  await waitForConnect(daemonB, "Bob");
  console.log("both daemons connected.\n");

  // ── TEST 1: sanity DM delivery A→B via the pre-created mailbox ─────
  appendJsonl(sanitySrc, { id: "sanity-1", from: "Alice", to: "Charlie", body: "hello from A", timestamp: new Date().toISOString() });
  const sanityDest = path.join(dirB, "mailboxes", "Charlie.mailbox.jsonl");
  await waitFor(sanityDest, (msgs) => msgs.some((m) => m.id === "sanity-1"), SETTLE_MS + 5000);
  console.log("TEST 1 (basic DM A→B): PASS");

  // ── TEST 2: delivery survives compaction ─────────────────────────────
  const newId = "post-compact-msg";
  appendJsonl(mailboxA, { id: newId, from: "Alice", to: "Bob", body: "after compaction", timestamp: new Date().toISOString() });
  const removed = compact(mailboxA);
  assert.ok(removed > 0, `compaction should have removed >=1 line (removed=${removed})`);
  console.log(`compacted A's Bob mailbox (removed ${removed}); file now at ${readJsonl(mailboxA).length} lines`);

  const mailboxB = path.join(dirB, "mailboxes", "Bob.mailbox.jsonl");
  await waitFor(mailboxB, (msgs) => msgs.some((m) => m.id === newId), SETTLE_MS + 5000);

  // B should have received ONLY the new line — none of the 500 seeded history lines.
  const got = readJsonl(mailboxB);
  assert.strictEqual(got.length, 1, `B should have exactly 1 line (the post-compaction msg), got ${got.length}`);
  assert.strictEqual(got[0].id, newId);
  console.log("TEST 2 (delivery survives compaction): PASS");

  console.log("\nALL TESTS PASSED");
  cleanup();
  process.exit(0);
})().catch((err) => {
  console.error("\nFAILED:", err.message);
  cleanup();
  process.exit(1);
});
