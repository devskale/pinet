# PiNet Cross-Machine — Design

## The problem

PiNet agents communicate by writing to each other's files. On one machine, `~/.pinet/` is shared. Across machines, it isn't. You need a transport that makes remote agents' mailboxes accessible.

## Approaches considered

### Shared filesystem (NFS, SSHFS)

Mount remote `~/.pinet/` locally. PiNet code works unchanged — `fs.watch` and `appendFileSync` still work.

- **Pros**: zero code changes
- **Cons**: NFS is finicky, SSHFS is slow, needs sysadmin setup, not portable
- **Verdict**: works for simple cases, but not a real solution

### Relay server

Run a lightweight WebSocket server. Each machine syncs mailbox changes through it.

- **Pros**: clean architecture, works across networks, protocol is simple
- **Cons**: need to deploy a server, auth, reconnection handling

### Peer-to-peer (WebRTC)

Agents connect directly. No server.

- **Cons**: NAT traversal is hard, discovery is hard
- **Verdict**: not viable for PoC

### Periodic sync (rsync/git)

- **Cons**: minutes of latency
- **Verdict**: not viable

**Decision: relay server.**

---

## Architecture

```
Machine A (johann-mac)              Relay Server               Machine B (cloud)
~~~~~~~~~~~~~~~~~~~~~               ~~~~~~~~~~~~               ~~~~~~~~~~~~~~~~~
pi agent                            ws://relay:3000            pi agent
  │                                      │                        │
  ├── write BackendDev.mailbox.jsonl     │                        │
  │                                      │                        │
  ├── fs.watch fires ──► sync daemon ────┤                        │
  │   (detects change)   (forwards)      │                        │
  │                                      ├── fan out ──► sync daemon
  │                                      │               (receives)
  │                                      │                        ├── write BackendDev.mailbox.jsonl
  │                                      │                        ├── fs.watch fires
  │                                      │                        └── pi.sendMessage()
```

Three components:

1. **Relay server** — dumb WebSocket fan-out. No disk state. ~200 lines.
2. **Sync daemon** — per-machine process. Bridges `~/.pinet/` filesystem ↔ WebSocket. ~200 lines.
3. **PiNet extension** — unchanged. Reads and writes files as before.

The relay is a dumb pipe. It doesn't understand PiNet semantics — teams, mailboxes, identities. It syncs file changes. PiNet code stays the same.

---

## The sync daemon

Runs on each machine. One process, not per-agent.

### What it does

1. Watches `~/.pinet/` recursively for file changes (new lines, new files)
2. On change: reads the diff (new lines since last sync), sends to relay as `{ path, content }`
3. Receives diffs from relay, appends to local files
4. Auto-reconnects to relay with exponential backoff

### File watching problem

`fs.watch` fires for local agent writes. But when the sync daemon writes a remote change locally, `fs.watch` also fires — the daemon would re-send its own write. Solution:

- Sync daemon tags its writes with a marker: writes to a temp file, then renames. OR:
- Sync daemon ignores events from its own PID. OR:
- Sync daemon writes with a known prefix marker that the watcher skips.

Simplest: sync daemon sets a write-in-progress flag. Its own `fs.watch` handler checks the flag and skips.

### Conflict

Two machines writing to the same mailbox file. The sync daemon serializes — receives remote change, appends locally. Race is between local agent writes and sync daemon writes. Both use `appendFileSync`. Safe for writes < PIPE_BUF (4KB on Linux, can vary). Typical message is ~300 bytes.

---

## The relay server

Single Node.js process. WebSocket server.

### Behavior

- Accept connections with auth token
- Each connection is a "machine"
- On message from machine A: broadcast to all other connected machines
- No disk persistence — messages exist only in transit
- If a machine is disconnected when a message passes through, it misses it

### Message format

```json
{
  "type": "append",
  "path": "mailboxes/BackendDev.mailbox.jsonl",
  "lines": [
    "{\"id\":\"...\",\"from\":\"FrontendDev\",\"to\":\"BackendDev\",\"body\":\"hi\",\"timestamp\":\"...\"}"
  ]
}
```

The relay just forwards these. It doesn't parse the lines.

### Initial sync

When a machine connects, does it get full history? No — only messages from now on. Each machine's `~/.pinet/` is its own local history. If you want history, pre-sync via rsync/scp before starting.

---

## Configuration

New file: `~/.pinet/relay.json`

```json
{
  "url": "ws://192.168.0.137:3000",
  "token": "shared-secret-for-this-pinet-network",
  "machine": "johann-mac"
}
```

Each machine has one. The token is shared across all machines in the same PiNet network. Anyone with the token can connect and see all messages.

### No relay.json = local only

If `relay.json` doesn't exist, PiNet works exactly as before — local filesystem only. Cross-machine is opt-in.

---

## Security model

### PoC level

- Shared secret token in `relay.json`
- Unencrypted WebSocket over LAN (ws://)
- All connected machines see all file changes — no per-agent isolation
- Trust model: if you have the token, you're part of the network

### Production level (future)

- TLS (wss://)
- Per-agent tokens (relay validates agent identity, not just machine)
- End-to-end encryption (messages encrypted before writing, relay can't read)
- Per-team isolation (relay only routes to members' machines)

Not needed for PoC.

---

## Deployment

### Single command to start relay

```bash
npx pinet-relay --port 3000 --token my-secret
```

Or run it as a Docker container, or on a cloud VM. It's just a Node.js process.

### Single command to start sync daemon

```bash
npx pinet-sync
```

Reads `~/.pinet/relay.json` and starts syncing. Runs in background.

Or: PiNet extension auto-starts the sync daemon when it detects `relay.json`. No separate process needed — the extension handles it.

### Minimal deployment for two machines

```bash
# Machine A (runs relay + agent)
npx pinet-relay --port 3000 --token secret &
echo '{"url":"ws://localhost:3000","token":"secret","machine":"mac"}' > ~/.pinet/relay.json
npx pinet-sync &

# Machine B (connects to relay)
echo '{"url":"ws://192.168.0.137:3000","token":"secret","machine":"cloud"}' > ~/.pinet/relay.json
npx pinet-sync &
```

---

## Open questions

1. **Sync daemon as separate process vs embedded in extension?**
   - Separate: simpler, can run without pi, but one more thing to manage
   - Embedded: auto-started, but ties syncing to pi sessions

2. **File granularity**: sync entire files or individual lines?
   - Lines: more efficient, but need to track read pointers per file per machine
   - Files: simpler, but larger payloads
   - Decision: lines (append-only files make this natural)

3. **Relay persistence**: should the relay store messages for offline machines?
   - No for PoC: if machine B is offline, it misses messages. Agents on machine A still have them locally.
   - Future: relay could buffer and deliver on reconnect

4. **Multi-relay**: can you chain relays? For 3+ machines across different networks?
   - Out of scope for PoC
   - Each machine points to one relay. Relay-to-relay is a future problem.

5. **Machine vs agent identity**: should the relay know about agents, or just machines?
   - Just machines for PoC. The relay syncs file changes. It doesn't know what an agent is.

---

## Scale test: 100 agents, multi-team

How does the relay hold up with 100 agents across multiple teams?

### Scenario

```
10 machines, 10 agents each = 100 agents
5 teams: build (30 agents), test (20), design (15), infra (10), all-hands (100)
```

### Message volume estimate

| Event | Per agent | 100 agents | Payload |
|-------|-----------|------------|----------|
| Login | once | 100 messages | ~200B each |
| Team message | 1/min | 100/min across all teams | ~500B each |
| DM | 0.1/min | 10/min | ~400B each |
| Presence heartbeat | 1/min | 100/min | ~100B each |

**Total: ~210 messages/min = 3.5/sec, ~100KB/sec**

This is nothing for a WebSocket relay. A single Node.js process handles 10,000+ concurrent WebSocket connections at this volume.

### Where it breaks

1. **`fs.watch` noise** — 100 agents on one machine = 10 mailboxes + 5 team files changing constantly. `fs.watch` fires per file change. 100 agents watching the same team file = 100 watcher callbacks per team message. At 100 messages/min across 5 teams = 500 watcher fires/min per machine. Manageable.

2. **Append contention on team files** — 30 agents writing to `teams/build/messages.jsonl` simultaneously. `appendFileSync` with writes < 512 bytes is atomic on macOS/Linux. 30 concurrent appends of ~500B each = interleaving risk on Linux. **Mitigation**: lock file for high-concurrency team writes. Sync daemon acquires `teams/<name>.lock`, appends, releases.

3. **Relay fan-out** — each message from machine A gets sent to 9 other machines. 100 messages/min × 9 = 900 outgoing messages/min from relay. Negligible.

4. **Sync daemon read amplification** — each file change on machine A gets synced to all 9 other machines. Each machine writes locally. All 10 agents on machine B see the write. Filter: only the targeted agent's mailbox triggers `pi.sendMessage()`. Team messages: all agents in the team see it. Self-filtering skips own messages. So 30 agents in `build` team = 30 × (messages from other 29) = 870 deliveries per minute across all machines. Each delivery is a `pi.sendMessage()` call. Manageable.

5. **Presence files** — 100 presence files, each machine syncs all of them. Presence updates every minute per agent = 100 presence writes/min. Each gets synced to 9 machines = 900 presence syncs/min. Fine.

### The real bottleneck: the LLMs

100 agents = 100 LLM sessions. Each triggered by `triggerTurn: true`. If 30 agents in `build` all receive a team message and respond, that's 30 simultaneous LLM API calls. At $0.01-0.05 per call, a minute of chatty agents costs $1-5. **The filesystem and relay are not the bottleneck — the API bill is.**

### Scale test plan

```
Phase A: 4 agents, 1 team (already validated ✅)
Phase B: 10 agents, 2 teams, 2 machines (relay PoC)
Phase C: 30 agents, 3 teams, 3 machines (stress test)
Phase D: 100 agents, 5 teams, 10 machines (scale test)
```

Each phase validates:
- Message delivery latency
- Watcher accuracy (no missed or duplicated messages)
- Lock contention on team files
- Relay throughput and memory
- LLM cost per minute

### Optimization for scale

| Problem | Solution |
|---------|----------|
| Team file contention | Lock file per team, 50ms timeout |
| Presence noise | Sync daemon batches presence updates (1/sec, not per-write) |
| Relay memory | No buffer — fire and forget. Offline machines miss messages |
| Sync daemon ↔ fs.watch loop | PID-based write filtering in sync daemon |
| LLM cost | Delivery modes (Phase 2b) — most agents on `digest` or `silent`, not `interrupt` |

---

## What doesn't change

- PiNet extension code: unchanged
- File layout: unchanged (`~/.pinet/` is the same)
- Message format: unchanged
- Teams, DMs, presence: all work the same
- Name@team login: unchanged

The sync daemon is a transparent bridge. PiNet doesn't know it exists.
