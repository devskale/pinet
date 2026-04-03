# Jot WebSocket Agent Daemon

## Problem

Pi agents operate through short-lived bash commands. Each tool call is independent — there's no persistent state between calls. WebSocket requires a long-lived connection, which doesn't fit pi's execution model.

Meanwhile, the REST API for jot has a fundamental limitation: **agents can't see each other's edits in real-time**. There's no push notification for REST-only clients. If agentA and agentB both edit the same note, they operate on stale state and get `"oldText not found"` errors.

## Solution

A lightweight Node.js daemon that maintains a persistent WebSocket connection to a jot shared note, and exposes a local interface that pi agents can interact with using standard bash tools.

## Architecture

```
┌─────────────┐    Unix socket     ┌──────────────────┐    WebSocket    ┌─────────────┐
│  Pi agent    │ ◄──────────────► │  jot-ws.mjs      │ ◄─────────────► │  Jot server │
│  (bash cmds) │  read state file  │  (background)    │  mutations      │             │
│              │  send edit pipe   │                  │  broadcasts     │             │
└─────────────┘                   └──────────────────┘                 └─────────────┘
                                          │
                                          ▼
                                   state file (JSON)
                                   /tmp/jot-<name>-state.json
```

## Daemon behavior

### On startup

1. Connect to jot WebSocket: `wss://host/jot/?shareId=<shareId>`
2. Receive `hello` message with full collab state (markdown, idListState, serverCounter)
3. Write current state to a JSON state file:
   ```json
   {
     "noteId": "etugrui6",
     "title": "handpassKontext1",
     "markdown": "...",
     "serverCounter": 42,
     "updatedAt": "2026-04-02T...",
     "connected": true
   }
   ```
4. Start listening on a Unix socket or named pipe for commands

### On incoming mutation from other clients

1. Apply server's idListUpdates to local tracked state
2. Update state file with new markdown + serverCounter
3. Pi agent sees fresh state on next read

### On edit command from pi agent

1. Read the `oldText` from current markdown (verify it exists and is unambiguous)
2. Convert to semantic collab mutations (insert + delete with element IDs)
3. Send mutation message over WebSocket
4. Wait for server ack/broadcast
5. Update state file with confirmed state

### On disconnect

1. Set `"connected": false` in state file
2. Attempt reconnect with exponential backoff
3. On reconnect, receive fresh `hello` and rebuild state

## Pi agent interaction

```bash
# Read latest note content (always fresh, reflects other agents' edits)
cat /tmp/jot-agentKlark0-state.json | jq -r .markdown

# Check connection health
cat /tmp/jot-agentKlark0-state.json | jq .connected

# Send an edit (daemon handles collab protocol)
echo '{"edits":[{"oldText":"foo","newText":"bar"}]}' | socat - /tmp/jot-agentKlark0.sock

# Send an edit and wait for ack
echo '{"edits":[{"oldText":"foo","newText":"bar"}],"wait":true}' | socat - /tmp/jot-agentKlark0.sock
# returns: {"ok":true,"savedAt":"2026-04-02T..."}
```

## Why not REST?

| | REST (current CLI) | WebSocket daemon |
|---|---|---|
| See other agents' edits | ❌ Must poll or hit conflict | ✅ Push updates in real-time |
| Conflict rate | High (racy read-then-edit) | Low (always working on latest state) |
| Agent identity in collab | All edits marked as `__api__` | Each agent gets its own clientId |
| Presence (cursors) | ❌ | ✅ Name + color for each agent |
| Complexity | Low (simple HTTP) | Medium (daemon process) |
| Persistence | None (stateless) | State file survives between pi calls |

## Implementation plan

### jot-ws.mjs

Single file, no build step. Uses `ws` (already a jot dependency).

Key components:
- WebSocket client with reconnect logic
- `TrackedIdList` from `articulated` for local state tracking
- State file writer (atomic write via tmpfile + rename)
- Unix socket command server (using `net` module)
- Edit command handler: find oldText → convert to mutations → send → await ack

### SKILL.md

Instructions for pi agent:
1. Check if daemon is running (pid file or state file existence)
2. Start daemon if needed (background process)
3. Read state file for latest content
4. Send edits through Unix socket
5. Handle errors (disconnected, stale oldText, ambiguous match)
6. Stop daemon when done (or leave running for session)

### Setup

```bash
# Daemon script lives in the skill
~/.pi/agent/skills/jot/scripts/jot-ws.mjs

# Or symlink for global access
ln -s ~/.pi/agent/skills/jot/scripts/jot-ws.mjs ~/.local/bin/jot-ws
```

## Edge cases

### Stale edit from pi agent
If the agent reads state, thinks for a while, then sends an edit — another agent may have changed the text in between. The daemon detects `oldText` not found and returns an error. The skill instructs the agent to re-read and retry.

### Daemon crash
State file preserves last known `serverCounter`. On restart, daemon reconnects, receives fresh `hello`, and rebuilds state. No data loss since the server is source of truth.

### Multiple agents on same note
Each agent runs its own daemon instance with its own clientId, name, and color. The jot server handles multiplexing. All agents see each other's edits via broadcast.

### SSL (wss://)
The lubu instance uses self-signed certs. The daemon needs `NODE_TLS_REJECT_UNAUTHORIZED=0` or the cert path configured. Document this in SKILL.md.

## Relation to existing agents

| Agent | Current | With daemon |
|---|---|---|
| agentMaster | REST + API key | REST is fine (single owner, full access) |
| agentKlark0 | REST + share link | WebSocket daemon for real-time collab |
| agentPythonUtils | REST + share link | WebSocket daemon for real-time collab |

agentMaster doesn't need the daemon — it's the only owner and can use REST. The daemon is for **shared-note agents that need to collaborate with each other**.
