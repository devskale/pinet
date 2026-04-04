#!/usr/bin/env node
/**
 * PiNet Agent-to-Agent Testbench
 * All tests run locally: filesystem + relay on localhost
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const WebSocket = require("./pinet/node_modules/ws");

const PINET = path.join(os.homedir(), ".pinet");
const TB = path.join(PINET, "testbench");
const RELAY_PORT = 17654;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const NETWORK_TOKEN = "testbench-token";

let relayProc = null;

// =============================================================================
// Helpers
// =============================================================================

function clean() {
  if (fs.existsSync(TB)) fs.rmSync(TB, { recursive: true });
  fs.mkdirSync(TB, { recursive: true });
}

function p(...segs) { return path.join(TB, ...segs); }

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n")
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Relay management ──────────────────────────────────────────────────────

function startRelay() {
  return new Promise((resolve, reject) => {
    const tokenFile = p("relay-token");
    fs.writeFileSync(tokenFile, NETWORK_TOKEN);

    relayProc = spawn("node", [
      path.join(__dirname, "pinet", "relay.js"),
      "--port", String(RELAY_PORT),
      "--token-file", tokenFile,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let started = false;
    relayProc.stdout.on("data", d => {
      const s = d.toString();
      if (!started && s.includes("Ready")) {
        started = true;
        resolve();
      }
    });
    relayProc.stderr.on("data", d => {
      if (!started && d.toString().includes("Error")) {
        reject(new Error("Relay failed: " + d.toString()));
      }
    });
    setTimeout(() => { if (!started) reject(new Error("Relay timeout")); }, 5000);
  });
}

function stopRelay() {
  if (relayProc) { relayProc.kill(); relayProc = null; }
}

// ── WebSocket client helper ────────────────────────────────────────────────

function wsConnect(auth) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("WS connect timeout")); }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", ...auth }));
    });

    ws.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") {
        clearTimeout(timeout);
        resolve({ ws, welcome: msg });
      }
      if (msg.type === "error" && msg.code) {
        clearTimeout(timeout);
        reject(new Error("Auth failed: " + msg.message));
      }
    });

    ws.on("error", e => { clearTimeout(timeout); reject(e); });
    ws.on("close", (code, reason) => {
      clearTimeout(timeout);
      if (code >= 4000) reject(new Error(`Closed ${code}: ${reason}`));
    });
  });
}

function wsMessage(ws, msg) {
  return new Promise(resolve => {
    const handler = raw => {
      const m = JSON.parse(raw.toString());
      if (m.type !== "pong" && m.type !== "agent_online" && m.type !== "agent_offline") {
        ws.off("message", handler);
        resolve(m);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify(msg));
  });
}

function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === type) {
        ws.off("message", handler);
        clearTimeout(t);
        resolve(m);
      }
    };
    ws.on("message", handler);
  });
}

// =============================================================================
// Tests
// =============================================================================

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── 1. Filesystem ───────────────────────────────────────────────────────────

test("fs: presence write/read", () => {
  clean();
  writeJson(p("presence", "Alice.json"), { name: "Alice", status: "online", pid: process.pid });
  writeJson(p("presence", "Bob.json"), { name: "Bob", status: "online", pid: process.pid });
  const dir = p("presence");
  const entries = fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readJson(path.join(dir, f)));
  assert.strictEqual(entries.length, 2);
});

test("fs: stale presence cleaned", () => {
  clean();
  writeJson(p("presence", "Alive.json"), { name: "Alive", status: "online", pid: process.pid });
  writeJson(p("presence", "Dead.json"), { name: "Dead", status: "online", pid: 99999 });
  const dir = p("presence");
  const alive = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const e = readJson(path.join(dir, f));
    try { process.kill(e.pid, 0); alive.push(e); } catch { fs.unlinkSync(path.join(dir, f)); }
  }
  assert.strictEqual(alive.length, 1);
  assert.strictEqual(alive[0].name, "Alive");
});

test("fs: team create + roles", () => {
  clean();
  writeJson(p("teams", "build", "meta.json"), {
    name: "build",
    members: ["Alice", "Bob"],
    roles: { Alice: "frontend", Bob: "backend" },
    created: new Date().toISOString(),
  });
  const m = readJson(p("teams", "build", "meta.json"));
  assert.strictEqual(m.roles.Alice, "frontend");
  assert.strictEqual(m.roles.Bob, "backend");
});

test("fs: team messages JSONL", () => {
  clean();
  const f = p("teams", "build", "messages.jsonl");
  appendJsonl(f, { id: "1", from: "Alice", body: "Hello!" });
  appendJsonl(f, { id: "2", from: "Bob", body: "Hi!" });
  const msgs = readJsonl(f);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].body, "Hello!");
});

test("fs: DM mailbox", () => {
  clean();
  const f = p("mailboxes", "Bob.jsonl");
  appendJsonl(f, { id: "dm1", from: "Alice", to: "Bob", body: "Hey!" });
  appendJsonl(f, { id: "dm2", from: "Carol", to: "Bob", body: "Yo!" });
  const dms = readJsonl(f);
  assert.strictEqual(dms.length, 2);
  assert.strictEqual(dms[0].from, "Alice");
});

// ── 2. Relay ────────────────────────────────────────────────────────────────

test("relay: auth + welcome", async () => {
  const { ws, welcome } = await wsConnect({
    token: NETWORK_TOKEN, machine: "test", agent: "RelayTester",
  });
  assert.strictEqual(welcome.agent, "RelayTester");
  assert.strictEqual(welcome.network.totalAgents, 1);
  ws.close();
});

test("relay: bad token rejected", async () => {
  try {
    await wsConnect({ token: "wrong", machine: "test", agent: "BadToken" });
    assert.fail("Should have been rejected");
  } catch (e) {
    assert.ok(e.message.includes("Closed 4001") || e.message.includes("Rejected"));
  }
});

test("relay: agent name required", async () => {
  try {
    await wsConnect({ token: NETWORK_TOKEN, machine: "test" });
    assert.fail("Should have been rejected");
  } catch (e) {
    assert.ok(e.message.includes("4015") || e.message.includes("agent"));
  }
});

test("relay: two agents connect + see each other", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "Alice", teams: { build: "tok1" } });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "Bob", teams: { build: "tok1" } });

  // Both should see 2 agents
  assert.strictEqual(a.welcome.network.totalAgents, 1); // Alice connected first
  assert.strictEqual(b.welcome.network.totalAgents, 2); // Bob sees both
  assert.ok(b.welcome.allAgents.includes("Alice"));
  assert.ok(b.welcome.allAgents.includes("Bob"));

  a.ws.close();
  b.ws.close();
});

test("relay: message A→B via relay", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "MsgAlice", teams: { chat: "t1" } });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "MsgBob", teams: { chat: "t1" } });

  // Alice sends a message
  const recvPromise = waitForMessage(b.ws, "append");

  a.ws.send(JSON.stringify({
    type: "append",
    from: "mac",
    path: "teams/chat/messages.jsonl",
    lines: [{ id: "m1", from: "MsgAlice", body: "Hello Bob!", ts: new Date().toISOString() }],
  }));

  const received = await recvPromise;
  assert.strictEqual(received.type, "append");
  assert.ok(received.lines.length >= 1);

  a.ws.close();
  b.ws.close();
});

test("relay: message B→A via relay", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "EchoAlice", teams: { ping: "p1" } });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "EchoBob", teams: { ping: "p1" } });

  // Bob sends to Alice
  const recvPromise = waitForMessage(a.ws, "append");

  b.ws.send(JSON.stringify({
    type: "append",
    from: "pi5",
    path: "teams/ping/messages.jsonl",
    lines: [{ id: "r1", from: "EchoBob", body: "Reply!", ts: new Date().toISOString() }],
  }));

  const received = await recvPromise;
  assert.strictEqual(received.from, "pi5");
  assert.ok(received.lines[0].body.includes("Reply!"));

  a.ws.close();
  b.ws.close();
});

test("relay: agent_online broadcast", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "WatchAlice", teams: { w: "w1" } });

  // Listen for agent_online on A when B connects
  const onlinePromise = waitForMessage(a.ws, "agent_online");

  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "WatchBob", teams: { w: "w1" } });

  const online = await onlinePromise;
  assert.strictEqual(online.agent, "WatchBob");
  assert.strictEqual(online.machine, "pi5");

  a.ws.close();
  b.ws.close();
});

test("relay: agent_offline broadcast", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "OffAlice", teams: { o: "o1" } });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "OffBob", teams: { o: "o1" } });

  const offlinePromise = waitForMessage(a.ws, "agent_offline");
  b.ws.close();
  const offline = await offlinePromise;
  assert.strictEqual(offline.agent, "OffBob");

  a.ws.close();
});

test("relay: duplicate agent name rejected", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "DupTest", teams: { d: "d1" } });
  try {
    await wsConnect({ token: NETWORK_TOKEN, machine: "other", agent: "DupTest", teams: { d: "d1" } });
    assert.fail("Duplicate should be rejected");
  } catch (e) {
    assert.ok(e.message.includes("4010") || e.message.includes("taken"));
  }
  a.ws.close();
});

test("relay: same machine reconnects (4002)", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "Reconnect", teams: { r: "r1" } });
  // Same machine, same agent name — should replace (4002 the old one)
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "Reconnect", teams: { r: "r1" } });
  assert.strictEqual(b.welcome.agent, "Reconnect");
  // old 'a' should have been kicked — don't close it, it's already dead
  b.ws.close();
});

// ── 3. Full roundtrip ──────────────────────────────────────────────────────

test("roundtrip: Alice tasks Bob via relay", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "RTAlice", teams: { work: "wt" } });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "RTBob", teams: { work: "wt" } });

  // Alice sends task
  const taskPromise = waitForMessage(b.ws, "append");
  a.ws.send(JSON.stringify({
    type: "append", from: "mac",
    path: "teams/work/messages.jsonl",
    lines: [{ id: "t1", from: "RTAlice", body: "@RTBob create hello.txt with 'done'", ts: new Date().toISOString() }],
  }));

  const task = await taskPromise;
  assert.ok(task.lines[0].body.includes("@RTBob"));

  // Bob replies
  const replyPromise = waitForMessage(a.ws, "append");
  b.ws.send(JSON.stringify({
    type: "append", from: "pi5",
    path: "teams/work/messages.jsonl",
    lines: [{ id: "t2", from: "RTBob", body: "Done! hello.txt created", ts: new Date().toISOString() }],
  }));

  const reply = await replyPromise;
  assert.strictEqual(reply.from, "pi5");
  assert.ok(reply.lines[0].body.includes("Done!"));

  a.ws.close();
  b.ws.close();
});

test("roundtrip: DM Alice→Bob then Bob→Alice", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "DMAlice" });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "DMBob" });

  // Alice DMs Bob
  const dm1Promise = waitForMessage(b.ws, "append");
  a.ws.send(JSON.stringify({
    type: "append", from: "mac",
    path: "mailboxes/DMBob.jsonl",
    lines: [{ id: "dm1", from: "DMAlice", to: "DMBob", body: "Secret message" }],
  }));
  const dm1 = await dm1Promise;
  assert.strictEqual(dm1.from, "mac");

  // Bob DMs back
  const dm2Promise = waitForMessage(a.ws, "append");
  b.ws.send(JSON.stringify({
    type: "append", from: "pi5",
    path: "mailboxes/DMAlice.jsonl",
    lines: [{ id: "dm2", from: "DMBob", to: "DMAlice", body: "Got it!" }],
  }));
  const dm2 = await dm2Promise;
  assert.strictEqual(dm2.from, "pi5");

  a.ws.close();
  b.ws.close();
});

// =============================================================================
// Run
// =============================================================================

async function main() {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║  PiNet Testbench — localhost (fs + relay)   ║");
  console.log("╚═══════════════════════════════════════════╝\n");

  // Start relay
  process.stdout.write("  Starting relay on :" + RELAY_PORT + " ... ");
  await startRelay();
  console.log("✅\n");

  let pass = 0, fail = 0;

  for (const t of tests) {
    process.stdout.write(`  ${t.name} ... `);
    try {
      clean();
      await t.fn();
      console.log("✅");
      pass++;
    } catch (e) {
      console.log("❌ " + e.message.split("\n")[0]);
      fail++;
    }
  }

  stopRelay();
  clean();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
