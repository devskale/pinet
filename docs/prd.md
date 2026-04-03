# PiNet PoC — Dev Journey

## Goal

Make two pi agents in different directories talk to each other and collaborate on a common goal.

## The Test Scenario

```
~/code/hands/
├── frontend/          ← FrontendDev works here
├── backend/           ← BackendDev works here
├── shared/
│   └── GOAL.md        ← shared spec both agents read
├── pinet.md           ← the grand vision
└── prd.md             ← this file
```

Two terminals, two agents, one extension.

## What We Built

A single pi extension: `~/.pi/agent/extensions/pinet/index.ts`

### Extension provides:

**Command:**
- `/pinet <name>` — login, claim identity, start watching for messages
- `/pinet off` — go offline
- `/pinet` — show status (when already logged in)

**Tools (registered after login):**
- `pinet_send` — send DM to another agent
- `pinet_mail` — check unread messages
- `pinet_list` — list online agents

### Storage:

```
~/.pinet/
├── identities.jsonl       # { name, created } — append-only
├── personal/
│   ├── FrontendDev.jsonl  # messages TO FrontendDev
│   └── BackendDev.jsonl   # messages TO BackendDev
└── presence/
    ├── FrontendDev.json   # { status, pid, lastSeen }
    └── BackendDev.json
```

### How it works:

1. Agent A runs `/pinet BackendDev` → writes identity, sets presence online, starts `fs.watch` on `personal/BackendDev.jsonl`
2. Agent B runs `/pinet FrontendDev` → same
3. Agent B uses `pinet_send` to message BackendDev → appends JSON line to `personal/BackendDev.jsonl`
4. Agent A's file watcher fires → reads new lines → calls `pi.sendMessage({ content: "...", display: true }, { triggerTurn: true })` → agent sees the message in its conversation and can respond

### Message delivery:

- `pi.sendMessage()` with `triggerTurn: true` injects the message into the agent's conversation as a custom message
- This causes the LLM to see the message and potentially respond
- Uses the same mechanism as pi-messenger and the file-trigger example extension

### Key design decisions:

- **No lock files for PoC** — personal mailboxes have one writer per file (the sender writes to the recipient's file). For 2-agent PoC, no contention.
- **Line-count read pointer** — on login, count existing lines in mailbox. New messages = anything beyond that. Stored in memory only (resets on restart = backlog redelivered, which is fine for PoC).
- **100ms debounce** on file watcher — prevents duplicate delivery from rapid fs events.
- **Stale presence cleanup** — on `pinet_list`, dead PIDs get cleaned up.

---

## Dev Log

### Step 1: Research

Read the pi extension docs end-to-end. Key findings:
- `pi.registerCommand()` for `/pinet`
- `pi.registerTool()` for LLM-callable tools
- `pi.sendMessage({ customType, content, display }, { triggerTurn: true })` to inject messages
- `pi.on("session_shutdown")` for cleanup
- Extensions live in `~/.pi/agent/extensions/` and are auto-discovered
- TypeScript works directly (jiti transpiles)

### Step 2: Skeleton

Created `~/.pi/agent/extensions/pinet/index.ts` with the `/pinet` command handler.

### Step 3: Identity + Presence

Login creates identity in `identities.jsonl`, writes `presence/<name>.json` with PID. Logout writes status offline.

### Step 4: File Watcher

After login, `fs.watch` on the `personal/` directory. Filters to own mailbox file. Debounces 100ms. Reads new lines beyond stored count.

### Step 5: Tools

Registered `pinet_send`, `pinet_mail`, `pinet_list` on login. Each tool checks `myIdentity` first — returns "not logged in" error if null.

### Step 6: Test Scenario Setup

Created `shared/GOAL.md` with the todo app spec. Created `frontend/` and `backend/` directories.

---

## How to Test

### Terminal 1 (Backend):
```bash
cd ~/code/hands/backend
pi
```
```
> /pinet BackendDev
```
Then tell the agent:
```
You are BackendDev. Read shared/GOAL.md at ../shared/GOAL.md. 
Build the backend API. Use pinet_send to tell FrontendDev when the API is ready.
Use pinet_list to check if FrontendDev is online.
```

### Terminal 2 (Frontend):
```bash
cd ~/code/hands/frontend
pi
```
```
> /pinet FrontendDev
```
Then tell the agent:
```
You are FrontendDev. Read shared/GOAL.md at ../shared/GOAL.md.
Wait for BackendDev to tell you the API is ready (check pinet_mail).
Then build the frontend against the API.
Use pinet_send to ask BackendDev questions about the API.
```

### Expected flow:
1. BackendDev builds the API, sends: "API is live at localhost:3000. Endpoints: GET/POST /todos, PATCH/DELETE /todos/:id"
2. FrontendDev receives the message, builds the UI
3. FrontendDev sends: "Looks good! Can you also add a health check endpoint?"
4. BackendDev responds, adds the endpoint
5. Both agents coordinate until the todo app works end-to-end

---

## Status

Extension written. Ready to test.
