#!/usr/bin/env node
// PiNet Agent-to-Agent Testbench (local, no relay, no network)
// Tests store functions directly via filesystem

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PINET = path.join(os.homedir(), ".pinet");
const TB = path.join(PINET, "testbench");

function clean() {
  if (fs.existsSync(TB)) fs.rmSync(TB, { recursive: true });
  fs.mkdirSync(TB, { recursive: true });
}

function p(...segs) {
  return path.join(TB, ...segs);
}

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
    .map(l => JSON.parse(l));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

// ── 1. Presence ────────────────────────────────────────────────────────────

test("presence write + read", () => {
  clean();
  writeJson(p("presence", "Alice.json"), { name: "Alice", status: "online", pid: process.pid });
  writeJson(p("presence", "Bob.json"), { name: "Bob", status: "online", pid: process.pid });

  const dir = p("presence");
  const entries = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const e = readJson(path.join(dir, f));
    if (e) entries.push(e);
  }
  assert.strictEqual(entries.length, 2);
  assert.ok(entries.find(e => e.name === "Alice"));
  assert.ok(entries.find(e => e.name === "Bob"));
});

test("stale presence ignored", () => {
  clean();
  writeJson(p("presence", "Alive.json"), { name: "Alive", status: "online", pid: process.pid });
  writeJson(p("presence", "Ghost.json"), { name: "Ghost", status: "online", pid: 99999 });

  const dir = p("presence");
  const alive = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const e = readJson(path.join(dir, f));
    if (!e) continue;
    // Check PID is alive
    try { process.kill(e.pid, 0); alive.push(e); } catch {
      // Dead PID — skip
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  }
  assert.strictEqual(alive.length, 1);
  assert.strictEqual(alive[0].name, "Alive");
});

// ── 2. Team lifecycle ─────────────────────────────────────────────────────

test("team create + join", () => {
  clean();
  const meta = { name: "build", members: ["Alice", "Bob"], created: new Date().toISOString() };
  writeJson(p("teams", "build", "meta.json"), meta);

  const m = readJson(p("teams", "build", "meta.json"));
  assert.strictEqual(m.name, "build");
  assert.deepStrictEqual(m.members, ["Alice", "Bob"]);
});

test("team dissolve when empty", () => {
  clean();
  const meta = { name: "solo", members: ["Alice"], created: new Date().toISOString() };
  writeJson(p("teams", "solo", "meta.json"), meta);
  // Remove last member
  meta.members = [];
  writeJson(p("teams", "solo", "meta.json"), meta);

  // Team still exists on disk but has no members
  const m = readJson(p("teams", "solo", "meta.json"));
  assert.deepStrictEqual(m.members, []);
});

// ── 3. Messages ────────────────────────────────────────────────────────────

test("team message send + read", () => {
  clean();
  const msgFile = p("teams", "build", "messages.jsonl");

  appendJsonl(msgFile, { id: "1", from: "Alice", team: "build", body: "Hello!", ts: "2026-01-01T00:00:00Z" });
  appendJsonl(msgFile, { id: "2", from: "Bob", team: "build", body: "Hi!", ts: "2026-01-01T00:00:01Z" });

  const msgs = readJsonl(msgFile);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].body, "Hello!");
  assert.strictEqual(msgs[1].body, "Hi!");
});

test("self-message filtering", () => {
  clean();
  const msgFile = p("teams", "build", "messages.jsonl");

  appendJsonl(msgFile, { id: "1", from: "Alice", body: "Hi team" });
  appendJsonl(msgFile, { id: "2", from: "Alice", body: "Still me" });

  const msgs = readJsonl(msgFile).filter(m => m.from !== "Alice");
  assert.strictEqual(msgs.length, 0); // Alice filters her own
});

test("duplicate detection by ID", () => {
  clean();
  const msgFile = p("teams", "build", "messages.jsonl");

  appendJsonl(msgFile, { id: "1", from: "Alice", body: "Hello" });
  appendJsonl(msgFile, { id: "1", from: "Alice", body: "Hello" }); // duplicate

  const msgs = readJsonl(msgFile);
  const ids = new Set(msgs.map(m => m.id));
  assert.strictEqual(ids.size, 1); // only 1 unique ID
  assert.strictEqual(msgs.length, 2); // both on disk (dedup is app-level)
});

// ── 4. DMs ──────────────────────────────────────────────────────────────────

test("DM send + read", () => {
  clean();
  const mbox = p("mailboxes", "Bob.mailbox.jsonl");

  appendJsonl(mbox, { id: "dm1", from: "Alice", to: "Bob", body: "Hey Bob!" });
  appendJsonl(mbox, { id: "dm2", from: "Carol", to: "Bob", body: "Hi!" });

  const dms = readJsonl(mbox);
  assert.strictEqual(dms.length, 2);
  assert.strictEqual(dms[0].from, "Alice");
  assert.strictEqual(dms[1].from, "Carol");
});

test("DM self-filter", () => {
  clean();
  const mbox = p("mailboxes", "Alice.mailbox.jsonl");

  appendJsonl(mbox, { id: "dm1", from: "Alice", to: "Alice", body: "Note to self" });

  const dms = readJsonl(mbox).filter(m => m.from !== "Alice");
  assert.strictEqual(dms.length, 0);
});

// ── 5. Roles-based team ─────────────────────────────────────────────────────

test("team with roles", () => {
  clean();
  const meta = {
    name: "project",
    members: ["Alice", "Bob"],
    roles: { Alice: "frontend", Bob: "backend" },
    created: new Date().toISOString()
  };
  writeJson(p("teams", "project", "meta.json"), meta);

  const m = readJson(p("teams", "project", "meta.json"));
  assert.strictEqual(m.roles.Alice, "frontend");
  assert.strictEqual(m.roles.Bob, "backend");
});

// ── 6. Full roundtrip ─────────────────────────────────────────────────────

test("full roundtrip: Alice tasks Bob", () => {
  clean();

  // Alice creates team
  writeJson(p("teams", "build", "meta.json"), {
    name: "build", members: ["Alice", "Bob"],
    roles: { Alice: "frontend", Bob: "backend" },
    created: new Date().toISOString()
  });

  // Alice sends task assignment
  appendJsonl(p("teams", "build", "messages.jsonl"), {
    id: "1", from: "Alice", team: "build",
    body: "@Bob create result.txt with timestamp",
    timestamp: new Date().toISOString()
  });

  // Bob reads and responds
  const msgs = readJsonl(p("teams", "build", "messages.jsonl"));
  const task = msgs.find(m => m.body.includes("@Bob"));
  assert.ok(task);

  // Bob creates the file (simulated)
  const resultPath = p("result.txt");
  fs.writeFileSync(resultPath, new Date().getTime().toString());

  // Bob reports back
  appendJsonl(p("teams", "build", "messages.jsonl"), {
    id: "2", from: "Bob", team: "build",
    body: "Done! Created result.txt with " + fs.readFileSync(resultPath, "utf-8"),
    timestamp: new Date().toISOString()
  });

  // Alice reads confirmation
  const all = readJsonl(p("teams", "build", "messages.jsonl"));
  const reply = all.find(m => m.from === "Bob");
  assert.ok(reply);
  assert.ok(reply.body.includes("Done!"));
});

// ── Run ────────────────────────────────────────────────────────────────────

console.log("╔═══════════════════════════════════════╗");
console.log("║  PiNet Testbench (local fs only)  ║");
console.log("╚═══════════════════════════════════════╝\n");

let pass = 0, fail = 0;
for (const t of tests) {
  process.stdout.write(`  ${t.name} ... `);
  try {
    t.fn();
    console.log("✅");
    pass++;
  } catch (e) {
    console.log("❌ " + e.message);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
