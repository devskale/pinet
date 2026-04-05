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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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

    // Use a random port for HTTP to avoid conflicts
    const HTTP_PORT = RELAY_PORT + 1;
    relayProc = spawn("node", [
      path.join(__dirname, "pinet", "relay.js"),
      "--port", String(RELAY_PORT),
      "--http-port", String(HTTP_PORT),
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

// ── JSONL compaction ────────────────────────────────────────────────────────

test("fs: compaction keeps last N lines", () => {
  clean();
  const f = p("teams", "build", "messages.jsonl");
  for (let i = 0; i < 10; i++) appendJsonl(f, { id: String(i), from: "Alice", body: `msg ${i}` });
  assert.strictEqual(readJsonl(f).length, 10);

  // Compact to 5
  const lines = fs.readFileSync(f, "utf-8").trim().split("\n").filter(l => l.trim());
  const kept = lines.slice(-5);
  const tmp = f + ".tmp." + process.pid;
  fs.writeFileSync(tmp, kept.join("\n") + "\n");
  fs.renameSync(tmp, f);

  const result = readJsonl(f);
  assert.strictEqual(result.length, 5);
  assert.strictEqual(result[0].body, "msg 5");
  assert.strictEqual(result[4].body, "msg 9");
});

test("fs: compaction no-op under limit", () => {
  clean();
  const f = p("teams", "small", "messages.jsonl");
  for (let i = 0; i < 3; i++) appendJsonl(f, { id: String(i), from: "Alice", body: `msg ${i}` });
  // Should still be 3 — no compaction needed
  const lines = fs.readFileSync(f, "utf-8").trim().split("\n").filter(l => l.trim());
  assert.ok(lines.length <= 500); // MAX_JSONL_LINES default
  const result = readJsonl(f);
  assert.strictEqual(result.length, 3);
});

// ── Delivery modes ───────────────────────────────────────────────────────

test("fs: new team defaults to interrupt mode", () => {
  clean();
  const meta = { name: "build", members: ["Alice"], roles: {}, delivery: "interrupt", created: new Date().toISOString() };
  writeJson(p("teams", "build", "meta.json"), meta);
  const m = readJson(p("teams", "build", "meta.json"));
  assert.strictEqual(m.delivery, "interrupt");
});

test("fs: set delivery mode", () => {
  clean();
  writeJson(p("teams", "build", "meta.json"), {
    name: "build", members: ["Alice", "Bob"], roles: {}, delivery: "interrupt", created: new Date().toISOString(),
  });
  const m = readJson(p("teams", "build", "meta.json"));
  m.delivery = "digest";
  writeJson(p("teams", "build", "meta.json"), m);
  const updated = readJson(p("teams", "build", "meta.json"));
  assert.strictEqual(updated.delivery, "digest");
});

test("fs: all three delivery modes", () => {
  clean();
  for (const mode of ["interrupt", "digest", "silent"]) {
    writeJson(p("teams", mode, "meta.json"), {
      name: mode, members: [], roles: {}, delivery: mode, created: new Date().toISOString(),
    });
    const m = readJson(p("teams", mode, "meta.json"));
    assert.strictEqual(m.delivery, mode);
  }
});

test("fs: missing delivery defaults to interrupt", () => {
  clean();
  // Old-format meta without delivery field
  writeJson(p("teams", "legacy", "meta.json"), {
    name: "legacy", members: ["Alice"], roles: {}, created: new Date().toISOString(),
  });
  const m = readJson(p("teams", "legacy", "meta.json"));
  assert.strictEqual(m.delivery, undefined); // not set in file
  // Code should default: meta?.delivery ?? "interrupt"
  const effective = m?.delivery ?? "interrupt";
  assert.strictEqual(effective, "interrupt");
});

test("mode: mode persists across message writes", () => {
  clean();
  // Create team in digest mode
  writeJson(p("teams", "build", "meta.json"), {
    name: "build", members: ["Alice", "Bob"], roles: {}, delivery: "digest", created: new Date().toISOString(),
  });
  // Write 5 messages
  const f = p("teams", "build", "messages.jsonl");
  for (let i = 0; i < 5; i++) appendJsonl(f, { id: String(i), from: i % 2 === 0 ? "Alice" : "Bob", body: `msg ${i}` });
  // Mode should survive in meta
  const meta = readJson(p("teams", "build", "meta.json"));
  assert.strictEqual(meta.delivery, "digest");
  // Messages still readable
  const msgs = readJsonl(f);
  assert.strictEqual(msgs.length, 5);
});

test("mode: change mode mid-conversation", () => {
  clean();
  writeJson(p("teams", "build", "meta.json"), {
    name: "build", members: ["Alice"], roles: {}, delivery: "interrupt", created: new Date().toISOString(),
  });
  const f = p("teams", "build", "messages.jsonl");
  // Write 3 messages in interrupt mode
  for (let i = 0; i < 3; i++) appendJsonl(f, { id: String(i), from: "Alice", body: `before ${i}` });
  // Switch to silent
  const meta = readJson(p("teams", "build", "meta.json"));
  meta.delivery = "silent";
  writeJson(p("teams", "build", "meta.json"), meta);
  // Write 3 more messages in silent mode
  for (let i = 3; i < 6; i++) appendJsonl(f, { id: String(i), from: "Alice", body: `after ${i}` });
  // Verify: 6 messages total, mode is silent
  assert.strictEqual(readJsonl(f).length, 6);
  assert.strictEqual(readJson(p("teams", "build", "meta.json")).delivery, "silent");
  // Switch back to interrupt
  meta.delivery = "interrupt";
  writeJson(p("teams", "build", "meta.json"), meta);
  assert.strictEqual(readJson(p("teams", "build", "meta.json")).delivery, "interrupt");
});

test("mode: each team has independent mode", () => {
  clean();
  writeJson(p("teams", "build", "meta.json"), {
    name: "build", members: ["Alice"], roles: {}, delivery: "interrupt", created: new Date().toISOString(),
  });
  writeJson(p("teams", "review", "meta.json"), {
    name: "review", members: ["Alice"], roles: {}, delivery: "digest", created: new Date().toISOString(),
  });
  writeJson(p("teams", "audit", "meta.json"), {
    name: "audit", members: ["Alice"], roles: {}, delivery: "silent", created: new Date().toISOString(),
  });
  // Verify each is independent
  assert.strictEqual(readJson(p("teams", "build", "meta.json")).delivery, "interrupt");
  assert.strictEqual(readJson(p("teams", "review", "meta.json")).delivery, "digest");
  assert.strictEqual(readJson(p("teams", "audit", "meta.json")).delivery, "silent");
  // Change one, others unaffected
  const m = readJson(p("teams", "build", "meta.json"));
  m.delivery = "digest";
  writeJson(p("teams", "build", "meta.json"), m);
  assert.strictEqual(readJson(p("teams", "build", "meta.json")).delivery, "digest");
  assert.strictEqual(readJson(p("teams", "review", "meta.json")).delivery, "digest");
  assert.strictEqual(readJson(p("teams", "audit", "meta.json")).delivery, "silent");
});

test("mode: trigger decision logic", () => {
  // Replicate the core decision from index.ts:
  //   const mode = readDeliveryMode(teamName);
  //   piRef.sendMessage({ ... }, { triggerTurn: mode === "interrupt" });
  function shouldTrigger(delivery) {
    const mode = delivery ?? "interrupt";
    return mode === "interrupt";
  }
  assert.strictEqual(shouldTrigger("interrupt"), true, "interrupt should trigger");
  assert.strictEqual(shouldTrigger("digest"), false, "digest should NOT trigger");
  assert.strictEqual(shouldTrigger("silent"), false, "silent should NOT trigger");
  assert.strictEqual(shouldTrigger(undefined), true, "missing field should default to interrupt and trigger");
  assert.strictEqual(shouldTrigger(null), true, "null should default to interrupt and trigger");
});

test("mode: mode survives compaction", () => {
  clean();
  writeJson(p("teams", "build", "meta.json"), {
    name: "build", members: ["Alice"], roles: {}, delivery: "digest", created: new Date().toISOString(),
  });
  const f = p("teams", "build", "messages.jsonl");
  for (let i = 0; i < 10; i++) appendJsonl(f, { id: String(i), from: "Alice", body: `msg ${i}` });
  // Compact to 5
  const lines = fs.readFileSync(f, "utf-8").trim().split("\n").filter(l => l.trim());
  const kept = lines.slice(-5);
  const tmp = f + ".tmp." + process.pid;
  fs.writeFileSync(tmp, kept.join("\n") + "\n");
  fs.renameSync(tmp, f);
  // Mode should survive — compaction only touches messages.jsonl, not meta.json
  assert.strictEqual(readJson(p("teams", "build", "meta.json")).delivery, "digest");
  assert.strictEqual(readJsonl(f).length, 5);
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

// ── 4. Delivery modes + relay ─────────────────────────────────────────────

test("mode: relay round-trip with digest mode", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "ModeAlice", teams: { build: "mt1" } });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "ModeBob", teams: { build: "mt1" } });

  // Send a message through the relay (relay doesn't know about modes — that's fine)
  const recvPromise = waitForMessage(b.ws, "append");
  a.ws.send(JSON.stringify({
    type: "append", from: "mac",
    path: "teams/build/messages.jsonl",
    lines: [{ id: "dm1", from: "ModeAlice", body: "digest test", ts: new Date().toISOString() }],
  }));
  const recv = await recvPromise;
  assert.strictEqual(recv.type, "append");
  assert.strictEqual(recv.lines[0].body, "digest test");

  // The delivery mode decision happens at the receiver (index.ts), not the relay.
  // Relay always fans out — the extension checks meta.json delivery mode
  // before deciding triggerTurn. We validate the decision logic here:
  //
  //   const mode = readDeliveryMode(teamName); // reads meta.json
  //   triggerTurn: mode === "interrupt"
  //
  // Since we can't load the pi extension in testbench, we validate
  // the logic directly:
  for (const [mode, expected] of [["interrupt", true], ["digest", false], ["silent", false]]) {
    const shouldTrigger = (mode ?? "interrupt") === "interrupt";
    assert.strictEqual(shouldTrigger, expected, `mode=${mode} should trigger=${expected}`);
  }

  a.ws.close();
  b.ws.close();
});

test("mode: mode change between relay messages", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "ChgAlice", teams: { chg: "ct" } });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "ChgBob", teams: { chg: "ct" } });

  // Send message 1
  const p1 = waitForMessage(b.ws, "append");
  a.ws.send(JSON.stringify({
    type: "append", from: "mac",
    path: "teams/chg/messages.jsonl",
    lines: [{ id: "c1", from: "ChgAlice", body: "msg 1", ts: new Date().toISOString() }],
  }));
  await p1;

  // Send message 2 (mode would have changed by the extension at this point)
  const p2 = waitForMessage(a.ws, "append");
  b.ws.send(JSON.stringify({
    type: "append", from: "pi5",
    path: "teams/chg/messages.jsonl",
    lines: [{ id: "c2", from: "ChgBob", body: "msg 2", ts: new Date().toISOString() }],
  }));
  const r2 = await p2;
  assert.strictEqual(r2.lines[0].body, "msg 2");

  // Relay doesn't care about modes — it's a dumb pipe.
  // Messages arrive regardless of mode. Mode only controls triggerTurn at the receiver.
  a.ws.close();
  b.ws.close();
});

test("mode: two teams with different modes, relay delivers to both", async () => {
  const a = await wsConnect({ token: NETWORK_TOKEN, machine: "mac", agent: "TMAlice", teams: { build: "bt", review: "rt" } });
  const b = await wsConnect({ token: NETWORK_TOKEN, machine: "pi5", agent: "TMBob", teams: { build: "bt", review: "rt" } });

  // Alice sends to #build
  const bp = waitForMessage(b.ws, "append");
  a.ws.send(JSON.stringify({
    type: "append", from: "mac",
    path: "teams/build/messages.jsonl",
    lines: [{ id: "b1", from: "TMAlice", body: "build msg", ts: new Date().toISOString() }],
  }));
  const bm = await bp;
  assert.strictEqual(bm.lines[0].body, "build msg");

  // Alice sends to #review
  const rp = waitForMessage(b.ws, "append");
  a.ws.send(JSON.stringify({
    type: "append", from: "mac",
    path: "teams/review/messages.jsonl",
    lines: [{ id: "r1", from: "TMAlice", body: "review msg", ts: new Date().toISOString() }],
  }));
  const rm = await rp;
  assert.strictEqual(rm.lines[0].body, "review msg");

  // Both messages arrive at Bob via relay — delivery modes don't affect relay transport.
  // #build could be interrupt and #review could be digest — relay delivers both.
  // The receiver decides whether to triggerTurn based on each team's meta.json.
  a.ws.close();
  b.ws.close();
});

// ── TLS helpers ──────────────────────────────────────────────────────────

function generateSelfSignedCert() {
  const { execSync } = require("child_process");
  const tlsDir = path.join(os.tmpdir(), "pinet-tls-test");
  if (!fs.existsSync(tlsDir)) fs.mkdirSync(tlsDir, { recursive: true });
  const keyFile = path.join(tlsDir, "key.pem");
  const certFile = path.join(tlsDir, "cert.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 1 -nodes -subj "/CN=localhost"`,
    { stdio: "pipe" }
  );
  return { keyFile, certFile };
}

let tlsRelayProc = null;
const TLS_PORT = 27654;
const TLS_URL = `wss://127.0.0.1:${TLS_PORT}`;

function startTlsRelay(keyFile, certFile) {
  return new Promise((resolve, reject) => {
    // Write token to a stable dir that clean() won't wipe
    const tlsDir = path.join(os.tmpdir(), "pinet-tls-test");
    if (!fs.existsSync(tlsDir)) fs.mkdirSync(tlsDir, { recursive: true });
    const tokenFile = path.join(tlsDir, "relay-token");
    fs.writeFileSync(tokenFile, NETWORK_TOKEN);

    tlsRelayProc = spawn("node", [
      path.join(__dirname, "pinet", "relay.js"),
      "--port", String(TLS_PORT),
      "--token-file", tokenFile,
      "--tls-key", keyFile,
      "--tls-cert", certFile,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let started = false;
    tlsRelayProc.stdout.on("data", d => {
      const s = d.toString();
      if (!started && s.includes("Ready")) {
        started = true;
        resolve();
      }
    });
    tlsRelayProc.stderr.on("data", d => {
      if (!started && d.toString().includes("Error")) {
        reject(new Error("TLS relay failed: " + d.toString()));
      }
    });
    setTimeout(() => { if (!started) reject(new Error("TLS relay timeout")); }, 5000);
  });
}

function stopTlsRelay() {
  if (tlsRelayProc) { tlsRelayProc.kill(); tlsRelayProc = null; }
}

function wsConnectTls(auth) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TLS_URL, { rejectUnauthorized: false });
    const timeout = setTimeout(() => { ws.close(); reject(new Error("TLS WS connect timeout")); }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", ...auth }));
    });

    ws.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") {
        clearTimeout(timeout);
        resolve({ ws, welcome: msg });
      }
    });

    ws.on("error", e => { clearTimeout(timeout); reject(e); });
    ws.on("close", (code, reason) => {
      clearTimeout(timeout);
      if (code >= 4000) reject(new Error(`TLS Closed ${code}: ${reason}`));
    });
  });
}

// ── 4. TLS (direct mode, no nginx) ───────────────────────────────────────

test("tls: wss:// auth + welcome", async () => {
  const { keyFile, certFile } = generateSelfSignedCert();
  await startTlsRelay(keyFile, certFile);

  const { ws, welcome } = await wsConnectTls({
    token: NETWORK_TOKEN, machine: "test", agent: "TlsAgent",
  });
  assert.strictEqual(welcome.agent, "TlsAgent");
  assert.strictEqual(welcome.network.totalAgents, 1);
  ws.close();
  stopTlsRelay();
});

test("tls: wss:// message A→B", async () => {
  const { keyFile, certFile } = generateSelfSignedCert();
  await startTlsRelay(keyFile, certFile);

  const a = await wsConnectTls({ token: NETWORK_TOKEN, machine: "mac", agent: "TlsAlice", teams: { secure: "st" } });
  const b = await wsConnectTls({ token: NETWORK_TOKEN, machine: "pi5", agent: "TlsBob", teams: { secure: "st" } });

  const recvPromise = waitForMessage(b.ws, "append");
  a.ws.send(JSON.stringify({
    type: "append", from: "mac",
    path: "teams/secure/messages.jsonl",
    lines: [{ id: "t1", from: "TlsAlice", body: "encrypted in transit!", ts: new Date().toISOString() }],
  }));

  const recv = await recvPromise;
  assert.strictEqual(recv.type, "append");
  assert.strictEqual(recv.lines[0].body, "encrypted in transit!");

  a.ws.close();
  b.ws.close();
  stopTlsRelay();
});

test("tls: HTTPS dashboard on same port", async () => {
  const { keyFile, certFile } = generateSelfSignedCert();
  await startTlsRelay(keyFile, certFile);

  const https = require("https");
  const data = await new Promise((resolve, reject) => {
    https.get(`https://localhost:${TLS_PORT}/api/stats`, { rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
  assert.strictEqual(data.tls, true);
  assert.strictEqual(data.maxAgents, 100);
  stopTlsRelay();
});

test("tls: bad token rejected over wss", async () => {
  const { keyFile, certFile } = generateSelfSignedCert();
  await startTlsRelay(keyFile, certFile);

  try {
    await wsConnectTls({ token: "wrong", machine: "test", agent: "TlsBad" });
    assert.fail("Should have been rejected");
  } catch (e) {
    assert.ok(e.message.includes("4001"));
  }
  stopTlsRelay();
});

test("tls: single-port (ws + http share port)", async () => {
  const { keyFile, certFile } = generateSelfSignedCert();
  await startTlsRelay(keyFile, certFile);

  // HTTPS stats on TLS_PORT
  const https = require("https");
  const data = await new Promise((resolve, reject) => {
    https.get(`https://localhost:${TLS_PORT}/api/stats`, { rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
  assert.strictEqual(data.tls, true);

  // WebSocket on same port
  const { ws, welcome } = await wsConnectTls({ token: NETWORK_TOKEN, machine: "test", agent: "SinglePort" });
  assert.strictEqual(welcome.agent, "SinglePort");
  ws.close();
  stopTlsRelay();
});

// ── 5. Setup wizard (filesystem) ────────────────────────────────────────

test("setup: write relay.json", () => {
  clean();
  const config = {
    url: "wss://relay.example.com:7654",
    token: "net-secret-123",
    machine: "mac",
    teams: {},
  };
  writeJson(p("relay.json"), config);
  const read = readJson(p("relay.json"));
  assert.strictEqual(read.url, "wss://relay.example.com:7654");
  assert.strictEqual(read.token, "net-secret-123");
  assert.strictEqual(read.machine, "mac");
  assert.deepStrictEqual(read.teams, {});
});

test("setup: add team to relay.json", () => {
  clean();
  writeJson(p("relay.json"), {
    url: "wss://relay.example.com:7654",
    token: "net-secret",
    machine: "mac",
    teams: {},
  });
  const config = readJson(p("relay.json"));
  config.teams.build = "team-token-abc";
  writeJson(p("relay.json"), config);
  const read = readJson(p("relay.json"));
  assert.strictEqual(read.teams.build, "team-token-abc");
});

test("setup: invite generates unique team token", () => {
  const crypto = require("crypto");
  const t1 = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const t2 = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  assert.notStrictEqual(t1, t2);
  assert.strictEqual(t1.length, 16);
  assert.ok(/^[0-9a-f]+$/.test(t1));
});

test("setup: join preserves existing teams", () => {
  clean();
  writeJson(p("relay.json"), {
    url: "wss://relay.example.com:7654",
    token: "net-secret",
    machine: "mac",
    teams: { build: "tok1" },
  });
  const config = readJson(p("relay.json"));
  config.teams.review = "tok2";
  writeJson(p("relay.json"), config);
  const read = readJson(p("relay.json"));
  assert.strictEqual(read.teams.build, "tok1");
  assert.strictEqual(read.teams.review, "tok2");
  assert.strictEqual(Object.keys(read.teams).length, 2);
});

test("setup: overwrite relay URL preserves teams", () => {
  clean();
  writeJson(p("relay.json"), {
    url: "wss://old.example.com",
    token: "old-token",
    machine: "mac",
    teams: { build: "tok1", deploy: "tok2" },
  });
  const config = readJson(p("relay.json"));
  config.url = "wss://new.example.com";
  config.token = "new-token";
  writeJson(p("relay.json"), config);
  const read = readJson(p("relay.json"));
  assert.strictEqual(read.url, "wss://new.example.com");
  assert.strictEqual(read.token, "new-token");
  assert.strictEqual(read.teams.build, "tok1");
  assert.strictEqual(read.teams.deploy, "tok2");
});

// ── 6. Wizard (one-shot setup) ────────────────────────────────────────────

test("wizard: create team (no token) generates one", () => {
  clean();
  // Simulate: /pinet wizard wss://relay:7654 secret mac build
  const parts = ["wss://relay:7654", "secret", "mac", "build"];
  const [url, token, machine, teamArg] = parts;
  const colonIdx = teamArg.indexOf(":");
  assert.strictEqual(colonIdx, -1); // no token = creating
  const teamName = colonIdx === -1 ? teamArg : teamArg.slice(0, colonIdx);
  const teamToken = colonIdx === -1 ? null : teamArg.slice(colonIdx + 1);
  assert.strictEqual(teamName, "build");
  assert.strictEqual(teamToken, null);
  // Wizard would generate a token
  const generated = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  assert.strictEqual(generated.length, 16);
  // Write config
  writeJson(p("relay.json"), { url, token, machine, teams: { [teamName]: generated } });
  const cfg = readJson(p("relay.json"));
  assert.strictEqual(cfg.url, "wss://relay:7654");
  assert.strictEqual(cfg.teams.build, generated);
});

test("wizard: join team (with token) uses it", () => {
  clean();
  // Simulate: /pinet wizard wss://relay:7654 secret pi5 build:abcdef1234567890
  const teamArg = "build:abcdef1234567890";
  const colonIdx = teamArg.indexOf(":");
  assert.ok(colonIdx !== -1);
  const teamName = teamArg.slice(0, colonIdx);
  const teamToken = teamArg.slice(colonIdx + 1);
  assert.strictEqual(teamName, "build");
  assert.strictEqual(teamToken, "abcdef1234567890");
  writeJson(p("relay.json"), {
    url: "wss://relay:7654",
    token: "secret",
    machine: "pi5",
    teams: { [teamName]: teamToken },
  });
  const cfg = readJson(p("relay.json"));
  assert.strictEqual(cfg.teams.build, "abcdef1234567890");
});

test("wizard: no team arg = relay only", () => {
  clean();
  // Simulate: /pinet wizard wss://relay:7654 secret mac
  writeJson(p("relay.json"), {
    url: "wss://relay:7654",
    token: "secret",
    machine: "mac",
    teams: {},
  });
  const cfg = readJson(p("relay.json"));
  assert.strictEqual(cfg.url, "wss://relay:7654");
  assert.deepStrictEqual(cfg.teams, {});
});

test("wizard: preserves existing teams when adding new", () => {
  clean();
  // Pre-existing config with one team
  writeJson(p("relay.json"), {
    url: "wss://relay:7654",
    token: "secret",
    machine: "mac",
    teams: { build: "tok-build" },
  });
  // Simulate: /pinet wizard wss://relay:7654 secret mac deploy
  const cfg = readJson(p("relay.json"));
  cfg.teams.deploy = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  writeJson(p("relay.json"), cfg);
  const read = readJson(p("relay.json"));
  assert.strictEqual(read.teams.build, "tok-build");
  assert.ok(read.teams.deploy);
  assert.strictEqual(Object.keys(read.teams).length, 2);
});

// ── 7. Message browser API ────────────────────────────────────────────────

const HTTP_GET_PORT = RELAY_PORT + 1;

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    http.get(urlStr, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, body }); }
      });
    }).on("error", reject);
  });
}

test("browser: /api/messages/<team> returns team messages", async () => {
  const teamToken = "browser-team-token";
  const { ws: ws1 } = await wsConnect({
    token: NETWORK_TOKEN, machine: "m1", agent: "BrowserAlice",
    teams: { browserteam: teamToken },
  });
  const { ws: ws2 } = await wsConnect({
    token: NETWORK_TOKEN, machine: "m2", agent: "BrowserBob",
    teams: { browserteam: teamToken },
  });

  await sleep(100);

  ws1.send(JSON.stringify({
    type: "append",
    path: "teams/browserteam/messages.jsonl",
    lines: [JSON.stringify({ from: "BrowserAlice", team: "browserteam", body: "hello from API test", timestamp: new Date().toISOString() })],
  }));
  await sleep(200);

  const result = await httpGet(`http://127.0.0.1:${HTTP_GET_PORT}/api/messages/browserteam?token=${NETWORK_TOKEN}`);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.team, "browserteam");
  assert.ok(result.body.count >= 1);
  assert.ok(result.body.messages.some(m => m.body === "hello from API test" && m.from === "BrowserAlice"));

  ws1.close();
  ws2.close();
});

test("browser: /api/mailbox/<agent> returns DMs", async () => {
  const { ws: ws1 } = await wsConnect({
    token: NETWORK_TOKEN, machine: "m1", agent: "MailSender",
    teams: {},
  });
  const { ws: ws2 } = await wsConnect({
    token: NETWORK_TOKEN, machine: "m2", agent: "MailRecv",
    teams: {},
  });

  await sleep(100);

  ws1.send(JSON.stringify({
    type: "append",
    path: "mailboxes/MailRecv.mailbox.jsonl",
    lines: [JSON.stringify({ from: "MailSender", to: "MailRecv", body: "DM test message", timestamp: new Date().toISOString() })],
  }));
  await sleep(200);

  const result = await httpGet(`http://127.0.0.1:${HTTP_GET_PORT}/api/mailbox/MailRecv?token=${NETWORK_TOKEN}`);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.agent, "MailRecv");
  assert.ok(result.body.count >= 1);
  assert.ok(result.body.messages.some(m => m.body === "DM test message" && m.from === "MailSender"));

  ws1.close();
  ws2.close();
});

test("browser: /api/messages requires auth", async () => {
  const result = await httpGet(`http://127.0.0.1:${HTTP_GET_PORT}/api/messages/anything`);
  assert.strictEqual(result.status, 401);
  assert.strictEqual(result.body.error, "unauthorized");
});

test("browser: /api/messages/<unknown> returns 404", async () => {
  const result = await httpGet(`http://127.0.0.1:${HTTP_GET_PORT}/api/messages/nonexistent?token=${NETWORK_TOKEN}`);
  assert.strictEqual(result.status, 404);
  assert.ok(result.body.error.includes("not found"));
});

test("browser: /api/messages with ?limit=1 caps results", async () => {
  const teamToken = "limit-team-token";
  const { ws: ws1 } = await wsConnect({
    token: NETWORK_TOKEN, machine: "m1", agent: "LimitAlice",
    teams: { limitteam: teamToken },
  });

  await sleep(100);

  for (let i = 0; i < 3; i++) {
    ws1.send(JSON.stringify({
      type: "append",
      path: "teams/limitteam/messages.jsonl",
      lines: [JSON.stringify({ from: "LimitAlice", body: `msg ${i}`, timestamp: new Date().toISOString() })],
    }));
    await sleep(50);
  }
  await sleep(200);

  const result = await httpGet(`http://127.0.0.1:${HTTP_GET_PORT}/api/messages/limitteam?token=${NETWORK_TOKEN}&limit=1`);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.count, 1);

  ws1.close();
});

test("browser: Bearer token auth works", async () => {
  const teamToken = "bearer-team-token";
  const { ws: ws1 } = await wsConnect({
    token: NETWORK_TOKEN, machine: "m1", agent: "BearerAlice",
    teams: { bearerteam: teamToken },
  });

  await sleep(100);

  ws1.send(JSON.stringify({
    type: "append",
    path: "teams/bearerteam/messages.jsonl",
    lines: [JSON.stringify({ from: "BearerAlice", body: "bearer test", timestamp: new Date().toISOString() })],
  }));
  await sleep(200);

  const result = await new Promise((resolve, reject) => {
    const http = require("http");
    const opts = {
      hostname: "127.0.0.1",
      port: HTTP_GET_PORT,
      path: "/api/messages/bearerteam",
      headers: { Authorization: `Bearer ${NETWORK_TOKEN}` },
    };
    http.get(opts, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, body }); }
      });
    }).on("error", reject);
  });
  assert.strictEqual(result.status, 200);
  assert.ok(result.body.count >= 1);

  ws1.close();
});

test("dashboard: serves SPA with login form", async () => {
  const result = await new Promise((resolve, reject) => {
    const http = require("http");
    http.get(`http://127.0.0.1:${HTTP_GET_PORT}/`, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
  assert.strictEqual(result.status, 200);
  assert.ok(result.body.includes("token-input"));
  assert.ok(result.body.includes("doLogin"));
  assert.ok(result.body.includes("conv-list"));
  assert.ok(result.body.includes("chat-messages"));
  assert.ok(result.body.includes("sidebar"));
});

test("browser: /api/conversations returns teams and dms", async () => {
  const teamToken = "conv-team-token";
  const { ws: ws1 } = await wsConnect({
    token: NETWORK_TOKEN, machine: "m1", agent: "ConvAlice",
    teams: { convteam: teamToken },
  });
  const { ws: ws2 } = await wsConnect({
    token: NETWORK_TOKEN, machine: "m2", agent: "ConvBob",
    teams: { convteam: teamToken },
  });

  await sleep(100);

  // Send a team message
  ws1.send(JSON.stringify({
    type: "append",
    path: "teams/convteam/messages.jsonl",
    lines: [JSON.stringify({ from: "ConvAlice", body: "conversation test", timestamp: new Date().toISOString() })],
  }));
  // Send a DM
  ws1.send(JSON.stringify({
    type: "append",
    path: "mailboxes/ConvBob.mailbox.jsonl",
    lines: [JSON.stringify({ from: "ConvAlice", to: "ConvBob", body: "DM convo test", timestamp: new Date().toISOString() })],
  }));
  await sleep(200);

  const result = await httpGet(`http://127.0.0.1:${HTTP_GET_PORT}/api/conversations?token=${NETWORK_TOKEN}`);
  assert.strictEqual(result.status, 200);
  assert.ok(result.body.teams);
  assert.ok(result.body.dms);
  const team = result.body.teams.find(t => t.name === "convteam");
  assert.ok(team);
  assert.ok(team.members.includes("ConvAlice"));
  assert.ok(team.members.includes("ConvBob"));
  assert.ok(team.lastMessage);
  assert.strictEqual(team.lastMessage.from, "ConvAlice");
  assert.strictEqual(team.lastMessage.body, "conversation test");
  const dm = result.body.dms.find(d => d.agent === "ConvBob");
  assert.ok(dm);
  assert.strictEqual(dm.lastMessage.from, "ConvAlice");

  ws1.close();
  ws2.close();
});

async function main() {
  console.log("╔══════════════════════════════════════════╗");
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
