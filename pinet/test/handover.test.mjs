/**
 * PiNet E2E handover test — two agents, real relay, full message round-trip.
 *
 * node --test test/handover.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocket } from "ws";

// ── Config ──────────────────────────────────────────────────────────────────

const RELAY_PORT = 17891;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const HTTP_PORT = RELAY_PORT + 1;
const TOKEN = "handover-test-token";
const TEAM_TOKEN = "team1-token";

const PINET_DIR = path.join(os.tmpdir(), `pinet-handover-test-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Connect to relay, auth, return { ws, welcome } */
function wsConnect(auth) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WS connect timeout"));
    }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", ...auth }));
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") {
        clearTimeout(timeout);
        resolve({ ws, welcome: msg });
      }
    });

    ws.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timeout);
      if (code >= 4000) reject(new Error(`Closed ${code}: ${reason}`));
    });
  });
}

/** Wait for a specific message type on a ws */
function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout waiting for ${type}`)),
      timeoutMs,
    );
    const handler = (raw) => {
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

/** Collect all non-presence messages for a duration */
function collectMessages(ws, durationMs = 2000) {
  const msgs = [];
  return new Promise((resolve) => {
    const handler = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== "pong" && m.type !== "agent_online" && m.type !== "agent_offline") {
        msgs.push(m);
      }
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      resolve(msgs);
    }, durationMs);
  });
}

// ── Relay lifecycle ─────────────────────────────────────────────────────────

let relayProc = null;

function startRelay() {
  return new Promise((resolve, reject) => {
    const tokenFile = path.join(PINET_DIR, "relay-token");
    ensureDir(PINET_DIR);
    fs.writeFileSync(tokenFile, TOKEN);

    relayProc = spawn(
      "node",
      [
        path.join(import.meta.dirname, "..", "relay.js"),
        "--port",
        String(RELAY_PORT),
        "--http-port",
        String(HTTP_PORT),
        "--token-file",
        tokenFile,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let started = false;
    relayProc.stdout.on("data", (d) => {
      if (!started && d.toString().includes("Ready")) {
        started = true;
        resolve();
      }
    });
    relayProc.stderr.on("data", (d) => {
      if (!started && d.toString().includes("Error")) {
        reject(new Error("Relay failed: " + d.toString()));
      }
    });
    setTimeout(() => {
      if (!started) reject(new Error("Relay start timeout"));
    }, 5000);
  });
}

function stopRelay() {
  if (relayProc) {
    relayProc.kill();
    relayProc = null;
  }
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

before(async () => {
  ensureDir(PINET_DIR);
  await startRelay();
});

after(() => {
  stopRelay();
  try {
    fs.rmSync(PINET_DIR, { recursive: true });
  } catch {}
});

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

describe("agent handover", () => {
  it("Alice tasks Bob via team chat, Bob replies", async () => {
    // 1. Connect both agents to the same team
    const alice = await wsConnect({
      token: TOKEN,
      machine: "mac",
      agent: "Alice",
      teams: { build: TEAM_TOKEN },
    });
    const bob = await wsConnect({
      token: TOKEN,
      machine: "pi5",
      agent: "Bob",
      teams: { build: TEAM_TOKEN },
    });

    assert.equal(alice.welcome.agent, "Alice");
    assert.equal(bob.welcome.agent, "Bob");
    assert.equal(bob.welcome.network.totalAgents, 2);

    // 2. Alice sends task to team
    const bobReceives = waitForMessage(bob.ws, "append");

    alice.ws.send(
      JSON.stringify({
        type: "append",
        from: "mac",
        path: "teams/build/messages.jsonl",
        lines: [
          {
            id: "task-1",
            from: "Alice",
            team: "build",
            body: "@Bob create hello.txt with content 'done'",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );

    const task = await bobReceives;
    assert.equal(task.type, "append");
    assert.equal(task.agent, "Alice");
    assert.equal(task.lines[0].body, "@Bob create hello.txt with content 'done'");

    // 3. Bob does work (writes file to local fs)
    const helloPath = path.join(PINET_DIR, "hello.txt");
    fs.writeFileSync(helloPath, "done");
    assert.ok(fs.existsSync(helloPath));

    // 4. Bob replies in team
    const aliceReceives = waitForMessage(alice.ws, "append");

    bob.ws.send(
      JSON.stringify({
        type: "append",
        from: "pi5",
        path: "teams/build/messages.jsonl",
        lines: [
          {
            id: "reply-1",
            from: "Bob",
            team: "build",
            body: "Done! hello.txt created",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );

    const reply = await aliceReceives;
    assert.equal(reply.agent, "Bob");
    assert.ok(reply.lines[0].body.includes("Done!"));

    alice.ws.close();
    bob.ws.close();
  });

  it("Alice DMs Bob, Bob reads and DMs back", async () => {
    const alice = await wsConnect({
      token: TOKEN,
      machine: "mac",
      agent: "DMAlice",
    });
    const bob = await wsConnect({
      token: TOKEN,
      machine: "pi5",
      agent: "DMBob",
    });

    // Alice → Bob DM
    const bobReceives = waitForMessage(bob.ws, "append");

    alice.ws.send(
      JSON.stringify({
        type: "append",
        from: "mac",
        path: "mailboxes/DMBob.jsonl",
        lines: [
          {
            id: "dm-1",
            from: "DMAlice",
            to: "DMBob",
            body: "Can you check the API?",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );

    const dm1 = await bobReceives;
    assert.equal(dm1.agent, "DMAlice");
    assert.ok(dm1.lines[0].body.includes("API"));

    // Bob → Alice DM reply
    const aliceReceives = waitForMessage(alice.ws, "append");

    bob.ws.send(
      JSON.stringify({
        type: "append",
        from: "pi5",
        path: "mailboxes/DMAlice.jsonl",
        lines: [
          {
            id: "dm-2",
            from: "DMBob",
            to: "DMAlice",
            body: "API is live, all endpoints pass",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );

    const dm2 = await aliceReceives;
    assert.equal(dm2.agent, "DMBob");
    assert.ok(dm2.lines[0].body.includes("API is live"));

    alice.ws.close();
    bob.ws.close();
  });

  it("3-agent team: Master tasks FrontendDev and BackendDev", async () => {
    const master = await wsConnect({
      token: TOKEN,
      machine: "mac",
      agent: "Master",
      teams: { squad: "sq1" },
    });
    const frontend = await wsConnect({
      token: TOKEN,
      machine: "mac",
      agent: "FrontendDev",
      teams: { squad: "sq1" },
    });
    const backend = await wsConnect({
      token: TOKEN,
      machine: "lubi",
      agent: "BackendDev",
      teams: { squad: "sq1" },
    });

    // Master sends task
    const feReceives = waitForMessage(frontend.ws, "append", 3000);
    const beReceives = waitForMessage(backend.ws, "append", 3000);

    master.ws.send(
      JSON.stringify({
        type: "append",
        from: "mac",
        path: "teams/squad/messages.jsonl",
        lines: [
          {
            id: "m-1",
            from: "Master",
            team: "squad",
            body: "@BackendDev build API. @FrontendDev stand by.",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );

    // Both non-sender agents receive
    const feTask = await feReceives;
    const beTask = await beReceives;
    assert.ok(feTask.lines[0].body.includes("@FrontendDev"));
    assert.ok(beTask.lines[0].body.includes("@BackendDev"));

    // BackendDev reports done
    const masterReceives = waitForMessage(master.ws, "append", 3000);

    backend.ws.send(
      JSON.stringify({
        type: "append",
        from: "lubi",
        path: "teams/squad/messages.jsonl",
        lines: [
          {
            id: "m-2",
            from: "BackendDev",
            team: "squad",
            body: "API live on :3000",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );

    const beReport = await masterReceives;
    assert.equal(beReport.agent, "BackendDev");

    master.ws.close();
    frontend.ws.close();
    backend.ws.close();
  });

  it("handover with filesystem round-trip (relay → file → read)", async () => {
    // This test validates: message goes through relay AND lands on filesystem
    const alice = await wsConnect({
      token: TOKEN,
      machine: "mac",
      agent: "FsAlice",
      teams: { work: "wt1" },
    });
    const bob = await wsConnect({
      token: TOKEN,
      machine: "pi5",
      agent: "FsBob",
      teams: { work: "wt1" },
    });

    // Alice writes team message to local file (simulating pinet_team_send)
    const teamPath = path.join(PINET_DIR, "teams", "work", "messages.jsonl");
    const msg = {
      id: "fs-1",
      from: "FsAlice",
      team: "work",
      body: "@FsBob write result.txt",
      timestamp: new Date().toISOString(),
    };
    appendJsonl(teamPath, msg);

    // Alice also sends it through relay (what sync.mjs would do)
    const bobReceives = waitForMessage(bob.ws, "append");

    alice.ws.send(
      JSON.stringify({
        type: "append",
        from: "mac",
        path: "teams/work/messages.jsonl",
        lines: [msg],
      }),
    );

    const received = await bobReceives;
    assert.equal(received.agent, "FsAlice");

    // Bob's side: write to local file (simulating sync.mjs inbound)
    appendJsonl(teamPath, {
      id: "fs-2",
      from: "FsBob",
      team: "work",
      body: "result.txt written",
      timestamp: new Date().toISOString(),
    });

    // Verify both messages on disk
    const onDisk = readJsonl(teamPath);
    assert.equal(onDisk.length, 2);
    assert.equal(onDisk[0].body, "@FsBob write result.txt");
    assert.equal(onDisk[1].body, "result.txt written");

    alice.ws.close();
    bob.ws.close();
  });
});
