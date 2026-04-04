# PiNet — Dev Journey & Roadmap

## Status

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Personal DMs | ✅ Done + validated |
| 2a | Teams (core) | ✅ Done + validated |
| 2b | Direct team messages (`/pinet msg`) | ✅ Done |
| 2c | Delivery modes | 🔲 Designed, not built |
| 2d | Threads | 🔲 Not started |
| 2e | Read receipts | 🔲 Not started |
| 2f | Reactions | 🔲 Not started |
| 2g | Mentions | 🔲 Not started |
| 2h | Pinned messages | 🔲 Not started |
| 3 | Routing (mirror + conditional) | 🔲 Design doc written |
| 4 | CLI | 🔲 Not started |
| 5 | Relay (cross-machine) | ✅ Done + validated |
| 5a | Dashboard | ✅ Done |
| 5b | Testbench | ✅ 17 tests passing |
| 6 | Agent daemon | 🔲 Not started |

---

## Phase 1: Personal DMs ✅

- `/pinet <name>` login with identity, presence, mailbox watcher
- `pinet_send`, `pinet_mail`, `pinet_list` tools
- File-based messaging via `~/.pinet/mailboxes/<name>.mailbox.jsonl`
- Validated: two agents (FrontendDev + BackendDev) built a full-stack todo app

## Phase 2a: Teams ✅

- `/pinet <name>@<team>` login — teams emerge from login, no separate create step
- `pinet_team_send`, `pinet_team_read`, `pinet_team_list` tools
- Shared team timeline via `~/.pinet/teams/<name>/messages.jsonl`
- Self-message filtering (skip own messages in team delivery)
- Validated: 4 agents (Master, BackendDev, FrontendDev, Tester) completed haiku challenge in team chat

### Extras added beyond original plan

- **Folder→identity bindings** — `/pinet` with no args reclaims last identity from cwd
- **Name generation** — `/pinet` with no args and no binding → auto-generates `SwiftFox`, `NeonDusk` etc
- **Team unread counts** — `/pinet` status and `pinet_team_list` show unread count per team
- **Modular code** — 5-file structure: types, store, watchers, tools, index

---

## Phase 2b: Direct Team Messages ✅

Send a message to a specific agent in your team directly from the `/pinet` command — no LLM tool call needed.

```
/pinet msg BackendDev hey, can you fix the CORS issue?
```

This writes to the team timeline (`messages.jsonl`) with the body prefixed by `@BackendDev`. The target agent sees it on their next poll/watch cycle.

### How it works

1. Agent runs `/pinet msg <target> <body>` in their pi session
2. The extension appends a message to `~/.pinet/teams/<team>/messages.jsonl`
3. Format: `{ from: "FrontendDev", body: "@BackendDev hey, can you fix the CORS issue?" }`
4. If relay + sync daemon are active, it propagates to remote machines
5. The target agent's team watcher picks it up on next poll

### Why this matters

- Agents can delegate tasks without the LLM needing to invoke `pinet_team_send` tool
- Human operators can send messages from the pi prompt without waiting for the LLM
- Works offline (filesystem) and online (relay sync)

---

## Phase 2c: Delivery Modes (designed, not built)

Let agents control how intrusive incoming messages are. Three modes per team:

| Mode | Behavior |
|------|----------|
| **interrupt** | Messages delivered immediately via `pi.sendMessage({ triggerTurn: true })`. LLM sees the message and responds right away. Default mode. |
| **digest** | Messages queue until the agent asks for them with `pinet_team_read`. No `triggerTurn`. Agent stays focused on its current task, reads team backlog when ready. |
| **silent** | Messages queue, no auto-trigger. Agent checks manually with `pinet_mail`. Same as digest but more explicit. |

**Why this matters:** In a 4-agent team the main timeline gets chatty. BackendDev doesn't want to be interrupted 20 times while building the API. Delivery modes let each agent set their own interruption budget.

**Implementation:** per-team mode stored in team `meta.json`:

```json
{
  "name": "build",
  "members": ["Master", "BackendDev", "FrontendDev", "Tester"],
  "delivery": {
    "Master": "interrupt",
    "BackendDev": "digest",
    "FrontendDev": "interrupt",
    "Tester": "silent"
  }
}
```

Tool to change mode: `pinet_team_mode`.

## Phase 2c: Threads (not started)

Sub-conversations within a team. Like Slack threads — a reply chain off the main timeline instead of flat messages.

```
team: build/
├── messages.jsonl          # main timeline
└── threads/
    └── <thread-id>.jsonl   # sub-conversations
```

When the main timeline gets noisy with multiple simultaneous topics, threads let agents fork side conversations without polluting the main channel.

**Why defer:** One flat timeline works fine for small teams (2-4 agents). Threads add complexity. Implement when a real scenario demonstrates the need.

## Phase 2d: Read Receipts (not started)

The sender knows their message was seen. Like WhatsApp blue checks.

```json
{"id":"uuid","from":"BackendDev","to":"FrontendDev","body":"API is live","timestamp":"...","readAt":"2026-04-03T11:00:00Z"}
```

When FrontendDev reads the message (via watcher or `pinet_mail`), the mailbox entry gets updated with `readAt`.

**Why defer:** Useful for senders to know their message landed. But agents are LLMs — they don't emotionally need acknowledgment. The team timeline inherently provides visibility. Implement when a real scenario shows agents wasting time re-sending because they don't know if their message was seen.

## Phase 2e: Reactions (not started)

Quick emoji feedback on messages — 👍 ❤ 🚀 ❓ — without writing a full message.

```json
{"id":"uuid","from":"Master","team":"build","reaction":"👍","reactTo":"<msg-id>","timestamp":"..."}
```

**Why defer:** Fun but not essential. Agents communicate via text. Reactions are a human UX pattern applied to agents. Implement for polish, not for function.

## Phase 2f: Mentions (not started)

`@AgentName` in a message body forces delivery even if the agent has delivery mode set to silent/digest. Overrides the per-team mode for that specific message.

**Why defer:** Nice-to-have. Agents already address each other by name in message text. The LLM naturally reads "BackendDev: please fix the CORS issue" and BackendDev responds. Formal `@` mentions with forced delivery are useful only when agents are in digest/silent mode and you need to escalate.

## Phase 2g: Pinned Messages (not started)

Mark specific messages as pinned context in a team. Always returned when reading the team timeline, regardless of read pointer.

```json
{"id":"uuid","pinned":true,"from":"Master","team":"build","body":"Spec: todo app, port 3000, CORS enabled","timestamp":"..."}
```

**Why defer:** Useful for long-running teams where the original spec gets buried in hundreds of messages. But for current PiNet use cases (short sessions, <50 messages), the full timeline is easily readable. Implement when real teams get large enough to need it.

---

## Phase 3: Routing (design doc written, not built)

See `docs/routing.md` for full design.

- **Mirror** — copy all messages from source to destination (team→team, agent→team)
- **Conditional** — forward only if message matches conditions (body contains "error", from specific agent)

Routes evaluated by the sender after writing. No background process needed.

Tools: `pinet_route_add`, `pinet_route_remove`, `pinet_route_list`.

---

## Phase 4: CLI (not started)

A `pinet` command for plain terminal use — no pi/LLM needed.

```bash
pinet who                    # list online agents
pinet mail                   # check personal DMs
pinet send Bob "hey"         # send a DM
pinet team list              # show teams
pinet team read build        # read team chat
```

Useful for: observing the network, sending quick messages, scripting (CI pipelines).

---

## Phase 5: Relay ✅

Cross-machine agent-to-agent communication via WebSocket relay.

### What's built

- **Relay server** (`relay.js`) — ~500 lines, WebSocket + HTTP
  - Token auth with reject codes (4001 bad token, 4010 name taken, 4015 no agent name)
  - Team membership tracking, per-team agent limits
  - Agent online/offline broadcasts to all connected peers
  - Same-machine reconnect (4002 — old connection kicked)
  - Dashboard HTML + `/api/stats` JSON endpoint

- **Sync daemon** (`sync.js`) — polling-based filesystem ↔ relay bridge
  - 2s polling for reliable cross-platform change detection
  - `PINET_AGENT_NAME` env var for per-agent identity on shared machines
  - Echo fix: `msg.from === config.machine` guard prevents loops
  - Auto-started by `/pinet` login when `relay.json` exists

- **Deployment**
  - Relay on lubu: `wss://neusiedl.duckdns.org:8001/pinet/`
  - Systemd service (`pinet-relay.service`) on lubu (port 7654)
  - Nginx proxy: `/pinet/` → WebSocket, `/pinet/dashboard/` → HTTP
  - Dashboard: `https://neusiedl.duckdns.org:8001/pinet/dashboard/`

- **Validation**
  - Cross-machine: mac ↔ lubu ↔ pi5 (3 machines, 3 agents)
  - Agent task delegation: FrontendDev tasked BackendDev to create file via team chat
  - Rate limiting: 5s gap, 10 msgs/min per team (in `tools.ts`)
  - Testbench: 17 tests passing (filesystem + relay on localhost)

### Architecture

```
Machine A (mac)                    Machine B (lubuntu)
┌──────────────┐                   ┌──────────────┐
│ pi agent     │                   │ pi agent     │
│  └─ sync.js ─┼─── WebSocket ────┼─┤            │
│     ~/.pinet │                   │  ~/.pinet    │
└──────────────┘                   └──────────────┘
                                          │
                                    relay.js :7654
                                    dashboard :8081
```

---

## Phase 6: Agent Daemon (not started)

Background process that watches mailboxes and spawns pi on demand.

- Watch all mailbox files
- When a message arrives for an offline agent, start pi in that agent's workspace dir
- Health monitoring, crash recovery

Enables "always-on" agents without keeping terminals open. Implement after relay, when agents are on multiple machines and need to be available 24/7.

---

## Architecture

```
~/.pinet/
├── identities.jsonl               # all-time login log
├── bindings/
│   └── <cwd-hash>.json            # folder → identity mapping
├── mailboxes/
│   └── <name>.mailbox.jsonl       # personal DMs (one per agent)
├── teams/
│   └── <team>/
│       ├── meta.json              # { members, delivery modes }
│       └── messages.jsonl         # shared timeline
└── presence/
    └── <name>.json                # { status, pid, lastSeen }
```

## Code structure

```
pinet/
├── types.ts      — interfaces, constants, PINET_DIR, NAME_PATTERN
├── store.ts      — all file I/O: jsonl, json, presence, identity, teams, bindings
├── watchers.ts   — fs.watch for mailboxes + team timelines, delivery
├── tools.ts      — 6 LLM tools (personal + team)
├── index.ts      — /pinet command, login/logout/status
└── package.json
```

## Key design decisions

| Decision | Why |
|----------|-----|
| `name@team` login | Teams emerge from login. No separate create/invite. |
| `.mailbox.jsonl` extension | Clear naming — it's a mailbox file |
| `mailboxes/` folder | Was `personal/` — renamed for clarity |
| Self-message filtering | Prevents infinite loops in team chats |
| No lock files | `appendFileSync` is atomic for small writes on macOS |
| No ACL | Any agent can create/join any team. Trust is social. |
| Model per workspace | `.pi/settings.json` in each agent dir. Not all agents need strong models. |
| Symlink extension per dir | Extension is project-local, not global. Each workspace links it. |
| `store.ts` has zero pi dependency | Clean separation — could be extracted as standalone lib |

---

## What's next (priority order)

1. **Real 4-agent build test** — todo-app scenario. Proves teams for real code.
2. **Phase 2b: Delivery modes** — interrupt/digest/silent. Real UX improvement.
3. **Phase 3: Routing** — mirror + conditional. Design ready.
4. **Phase 4: CLI** — observe without pi. Useful immediately.
5. **Phase 5: Relay** — cross-machine. Design doc at [docs/crossmachine.md](crossmachine.md). Scale test: 100 agents, 5 teams, 10 machines.
6. **Phase 6: Daemon** — always-on agents. After relay.
