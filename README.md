# PiNet

Agent-to-agent DMs for [pi](https://pi.dev/). Any number of agents, one shared filesystem, zero server.

Agents log in with a name, discover each other via presence files, and exchange messages through append-only JSONL mailboxes. No daemon, no network, no database — just `fs.watch` and `fs.appendFileSync`.

## Install

```bash
# Clone the repo
git clone https://github.com/devskale/pinet.git
cd pinet

# Link as a project-local extension (recommended)
mkdir -p .pi/extensions
ln -s "$(pwd)/pinet" .pi/extensions/pinet

# Or install as a pi package
pi install /path/to/pinet
```

## Quick reference

```
/pinet <name>              # log in as <name>
/pinet                     # show status
/pinet off                 # go offline
```

| Tool | Description |
|------|-------------|
| `pinet_send` | Send a DM to another agent |
| `pinet_mail` | Check your unread messages |
| `pinet_list` | See who's online |

---

## Setting up a collaborative team

PiNet is a generic network — you define the roles. A typical pattern is **workers + overseer**: specialist agents that build code, and a master agent that coordinates, reviews, and keeps everyone on track.

### Recommended: tmux

Run each agent in a separate tmux pane so you can observe all of them side by side:

```bash
# Create a session with panes for each agent
tmux new-session -s hands -d
tmux split-window -h -t hands
# Pane 1: frontend, Pane 2: backend
```

You can watch all agents work in parallel, scroll back to see message exchanges, and interact with any pane directly.

### The example: FrontendDev + BackendDev

This repo includes a ready-made scenario where two agents build a full-stack todo app together:

```
pinet/
├── scenarios/
│   └── todo-app.md          ← shared spec all agents read
├── pinet/                   ← the PiNet extension source
│   ├── index.ts
│   └── package.json
├── docs/                    ← design docs, dev journey
└── README.md
```

- **BackendDev** — builds the REST API (Node.js + Express)
- **FrontendDev** — builds the UI (vanilla HTML/CSS/JS), waits for the API to be ready

### Step 1: Create workspaces

```bash
mkdir -p frontend backend
```

### Step 2: Start tmux

```bash
tmux new-session -s hands
# Split into two panes
Ctrl+B %
```

### Step 3: Start both agents

**Pane 1 — FrontendDev:**

```bash
cd frontend
pi
```

Once pi starts:

```
/pinet FrontendDev
```

Then:

```
You are FrontendDev. Read ../scenarios/todo-app.md.
Use pinet_mail to check for messages. Wait for BackendDev
to confirm the API is ready, then build the frontend.
Use pinet_send to communicate.
```

**Pane 2 — BackendDev:**

```bash
cd backend
pi
```

Once pi starts:

```
/pinet BackendDev
```

Then:

```
You are BackendDev. Read ../scenarios/todo-app.md.
Build the backend API first. Use pinet_send to tell
FrontendDev when the API is live. Use pinet_list to check
if FrontendDev is online. Coordinate via pinet messages.
```

### Step 4: Watch them collaborate

A typical session:

1. **FrontendDev** sends: *"Hey BackendDev! Ready to build the frontend. Is the API up yet?"*
2. **BackendDev** builds the API, sends: *"API is live on localhost:3000 🚀 Endpoints: GET/POST /todos, PATCH/DELETE /todos/:id. CORS enabled."*
3. **FrontendDev** receives the message, builds the UI, sends back: *"Frontend is done! Tested against your API, works perfectly."*
4. **BackendDev** acknowledges: *"Great teamwork! Full-stack app done. 👏"*

All communication happens through PiNet — no human in the loop.

---

## How it works

All state lives in `~/.pinet/` on the local machine. No database, no server — just files.

```
~/.pinet/
├── identities.jsonl           # append-only login log (all-time)
├── personal/
│   ├── BackendDev.jsonl       # messages TO BackendDev
│   └── FrontendDev.jsonl      # messages TO FrontendDev
└── presence/
    ├── BackendDev.json        # current online/offline status
    └── FrontendDev.json
```

### Login (`/pinet <name>`)

No registration step — just pick a name and log in. Names are `a-zA-Z0-9_-`.

On login, four things happen:

1. **Identity logged** — appends `{ name, created }` to `~/.pinet/identities.jsonl`. This file is append-only and never cleaned — it's a historical record of every login ever.

2. **Presence written** — creates `~/.pinet/presence/<name>.json`:
   ```json
   {
     "name": "BackendDev",
     "status": "online",
     "pid": 94821,
     "lastSeen": "2026-04-03T10:55:47.710Z"
   }
   ```
   The `pid` is key — it lets other agents detect if you're really alive. If the PID is dead, `pinet_list` silently removes the stale entry.

   Only **one agent per name** can be online at a time. If you try to log in as "BackendDev" while another live process holds that name, login is rejected.

3. **Mailbox watcher starts** — `fs.watch` on `~/.pinet/personal/`, filtered to `<yourname>.jsonl`. Debounced 100ms to handle rapid filesystem events.

4. **Tools registered** — `pinet_send`, `pinet_mail`, `pinet_list` become available to the LLM.

### Sending messages (`pinet_send`)

Appends one JSON line to the recipient's mailbox:

```json
{"id":"f21cd8c2-4ec6-40f2-8ac5-2326a845b4c3","from":"FrontendDev","to":"BackendDev","body":"Is the API up yet?","timestamp":"2026-04-03T10:55:47.710Z"}
```

That's it — `fs.appendFileSync`. No locking needed because each mailbox has one writer (the sender) per message. Even with multiple senders, append is atomic on most OSes for small writes.

### Receiving messages (the watcher)

The watcher keeps an in-memory read pointer (`myLineCount`) — the number of lines in the mailbox at login. When `fs.watch` fires:

1. Read the full mailbox file
2. Slice from `myLineCount` onward — those are new messages
3. Update the pointer
4. Inject into the agent's conversation:

```typescript
pi.sendMessage(
  { customType: "pinet", content: "BackendDev: API is live!", display: true },
  { triggerTurn: true }  // wakes the LLM, causes it to respond
);
```

`triggerTurn: true` is the key — if the agent is idle, pi starts a new LLM turn so the agent can act on the message.

### Offline behavior

Messages are **durable**. If the recipient is offline:
- Messages still get appended to their mailbox file
- On next login, the agent gets a notification: "3 unread messages waiting. Use pinet_mail to read them."
- The watcher only fires for live agents

### Status (`/pinet`)

Shows your name, how many peers are online, and unread message count.

### Logout (`/pinet off`)

Writes `presence/<name>.json` with `status: "offline"`, stops the watcher, unregisters tools. The mailbox file stays — messages are never deleted.

### Crash recovery

If the pi process dies without `/pinet off`, the presence file stays as `online`. Next time anyone calls `pinet_list`, dead PIDs are detected via `process.kill(pid, 0)` and the stale presence file is silently deleted.

---

## Message flow walkthrough

Here's exactly what happens when FrontendDev and BackendDev talk to each other.

### Setup

Both agents start pi in their directories and run `/pinet <name>`. After login each agent has:
- A `fs.watch` on `~/.pinet/personal/` filtering for their own `.jsonl` file
- An in-memory read pointer (line count) set to the current mailbox size
- Three tools registered: `pinet_send`, `pinet_mail`, `pinet_list`

### FrontendDev asks BackendDev a question

1. FrontendDev's LLM decides to message BackendDev → calls `pinet_send({ to: "BackendDev", message: "Is the API up yet?" })`
2. PiNet appends one JSON line to `~/.pinet/personal/BackendDev.jsonl`
3. BackendDev's `fs.watch` fires (debounced 100ms)
4. BackendDev reads `BackendDev.jsonl`, slices new lines beyond its read pointer, advances the pointer
5. PiNet calls `pi.sendMessage({ content: "[PiNet] 1 new message:\nFrontendDev: Is the API up yet?" }, { triggerTurn: true })`
6. Pi injects this into BackendDev's conversation → LLM sees it and decides to respond

### BackendDev replies

7. BackendDev's LLM calls `pinet_send({ to: "FrontendDev", message: "API is live on localhost:3000!" })`
8. PiNet appends one JSON line to `~/.pinet/personal/FrontendDev.jsonl`
9. FrontendDev's `fs.watch` fires
10. Same flow in reverse: new line read → `pi.sendMessage({ triggerTurn: true })` → FrontendDev's LLM sees the reply

### Visual

```
FrontendDev (pid 48123)                     BackendDev (pid 48199)
~~~~~~~~~~~~~~~~~~~~~                       ~~~~~~~~~~~~~~~~~~~~~
watching: personal/FrontendDev.jsonl         watching: personal/BackendDev.jsonl
read pointer: 0 lines                        read pointer: 0 lines

  ┌─── pinet_send("BackendDev", "API up?") ───┐
  │                                            ▼
  │                            append to personal/BackendDev.jsonl
  │                                            │
  │                                 fs.watch fires (100ms debounce)
  │                                            │
  │                            read new lines beyond pointer (line 1)
  │                                            │
  │                            pi.sendMessage({ triggerTurn: true })
  │                                            │
  │                            LLM sees: "FrontendDev: API up?"
  │                                            │
  │                              ┌── pinet_send("FrontendDev", "Live!") ──┐
  │                              │                                         │
  ▼                              │                                         │
append to personal/FrontendDev.jsonl                                        │
  │                              │                                         │
fs.watch fires                  │                                         │
  │                              │                                         │
read new line (line 1)          │                                         │
  │                              │                                         │
pi.sendMessage({ triggerTurn }) │                                         │
  │                              │                                         │
LLM sees: "BackendDev: Live!"   │                                         │
  └──────────────────────────────┘─────────────────────────────────────────┘
```

Each mailbox file is append-only and never modified. The read pointer in each agent's process tracks what's been seen. Multiple messages can queue up if the agent is busy — they all get delivered on the next watcher callback.

### Key properties

- **No central server** — agents write directly to each other's mailbox files
- **No locking** — each file has one appender per message, append is atomic
- **No network** — everything is local filesystem
- **Durable** — messages persist even if the recipient is offline
- **Asymmetric** — FrontendDev writes to `BackendDev.jsonl`, BackendDev writes to `FrontendDev.jsonl`. Each agent only reads its own file.

---

## Docs

- [docs/pinet.md](docs/pinet.md) — full design vision
- [docs/prd.md](docs/prd.md) — dev journey and implementation notes
- [scenarios/todo-app.md](scenarios/todo-app.md) — example scenario spec

## License

MIT
