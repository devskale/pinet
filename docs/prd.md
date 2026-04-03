# PiNet — Dev Journey & Roadmap

## Status

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Personal DMs | ✅ Done + validated |
| 2a | Teams (core) | ✅ Done + validated |
| 2b | Delivery modes | 🔲 Designed, not built |
| 2c | Threads | 🔲 Not started |
| 2d | Read receipts | 🔲 Not started |
| 2e | Reactions | 🔲 Not started |
| 2f | Mentions | 🔲 Not started |
| 2g | Pinned messages | 🔲 Not started |
| 3 | Routing (mirror + conditional) | 🔲 Design doc written |
| 4 | CLI | 🔲 Not started |
| 5 | Relay (cross-machine) | 🔲 Not started |
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

- **Folder→identity bindings** — `/pinet` with no args reclaims last identity from cwd (`~/.pinet/bindings/<cwd-hash>.json`)
- **Name generation** — `/pinet` with no args and no binding → auto-generates `SwiftFox`, `NeonDusk` etc
- **Team unread counts** — `/pinet` status and `pinet_team_list` show unread count per team
- **Modular code** — 5-file structure: types, store, watchers, tools, index

---

## Phase 2b: Delivery Modes (designed, not built)

Let agents control how intrusive incoming messages are. Three modes per team:

| Mode | Behavior |
|------|----------|
| `interrupt` (default) | `triggerTurn: true` — LLM responds immediately |
| `digest` | Messages queue, delivered as batch every N seconds or M messages |
| `silent` | Messages queue, no auto-delivery. Agent checks manually via `pinet_team_read`. |

The problem this solves: when a team is chatty (4 agents actively talking), every message triggers an LLM turn on every other agent. That's expensive and disruptive. Delivery modes let agents batch or mute team noise.

Not yet implemented. Requires:
- Per-team mode setting (stored in memory, optionally in binding)
- `digest` needs a timer or counter that flushes queued messages
- `silent` just means the watcher doesn't call `pi.sendMessage()`

---

## Phase 2c: Threads (not started)

Sub-conversations within a team. Like Slack threads — someone sends a message, others reply in a side chain instead of the main timeline.

```
team "build" messages.jsonl         ← main timeline
team "build" threads/
  ├── abc123.jsonl                  ← thread off message abc123
  └── def456.jsonl                  ← thread off message def456
```

A thread is started by replying to a specific message ID. Thread messages have a `threadId` field. The main timeline stays clean.

Useful when multiple topics are discussed simultaneously in a team. Without threads, everything is one flat timeline.

---

## Phase 2d: Read Receipts (not started)

The sender knows their message was seen. Like WhatsApp blue checks.

Each agent writes read pointers: `~/.pinet/teams/<team>/.read/<name>.json` with `{ lastRead: <timestamp> }`. Senders can check who has read up to what point.

Tool: `pinet_team_read` would also update the read pointer. New tool: `pinet_team_receipts <team> <messageId>` to see who read a specific message.

Useful for knowing if your assignment was actually seen, not just sent.

---

## Phase 2e: Reactions (not started)

Quick feedback without writing a full message. 👍 ✅ ❌ 🚧

```json
{ "id": "uuid", "type": "reaction", "from": "BackendDev", "emoji": "👍", "messageId": "abc123", "timestamp": "..." }
```

Stored in the team's messages.jsonl alongside regular messages. Rendered inline in delivery. Agents can react to acknowledge without starting a conversation.

---

## Phase 2f: Mentions (not started)

`@AgentName` in a message body overrides delivery mode for that specific agent. Even if the agent is in `silent` mode for the team, an @mention triggers immediate delivery.

```
"Hey @BackendDev — CORS is broken, can you fix?"
```

The `@` prefix is detected during delivery. If the mentioned agent is in `silent` or `digest` mode, this specific message still gets delivered immediately.

---

## Phase 2g: Pinned Messages (not started)

Team context that sticks. Pinned message IDs are stored in the team meta:

```json
{
  "name": "build",
  "members": ["Master", "BackendDev", "FrontendDev", "Tester"],
  "pinned": ["msg-id-1", "msg-id-2"],
  "created": "..."
}
```

Tool: `pinet_team_pin <team> <messageId>` to pin. Pinned messages are included in the team summary when an agent joins or checks status.

Useful for: task assignments, API contracts, important decisions — things everyone should see without scrolling.

---

## Phase 3: Routing (design doc at docs/routing.md)

Two routing primitives:

**Mirror** — copy every message from source to destination.
```
team "build" → mirror to team "audit-log"
```

**Conditional** — forward only if message matches a condition.
```
team "build" contains "error" → forward to Tester
team "build" contains "deploy" → forward to team "ops"
```

Routes are JSON files in `~/.pinet/routes/`. Evaluated by the sender after writing. No background process needed. Loop prevention: no self-mirror, no re-routing routed messages, max 1 hop.

Tools: `pinet_route_add`, `pinet_route_remove`, `pinet_route_list`.

---

## Phase 4: CLI

A `pinet` command for plain terminals — no LLM needed.

```bash
pinet who                # who's online
pinet mail               # check your DMs
pinet send Bob "hey"     # send a DM
pinet team list          # show teams
pinet team read build    # read team chat
```

Useful for: observing the network, checking messages, sending quick notes, scripting (e.g. `pinet send BackendDev "deploy done"` from CI).

Needs to know your identity — reads the binding for cwd, or takes `--name` flag.

---

## Phase 5: Relay (cross-machine)

WebSocket relay server (~300 lines). Agents on different machines connect through it. Store-and-forward for offline agents. Token auth.

Big infrastructure effort. Only needed when agents run on different computers.

---

## Phase 6: Agent Daemon

Background process that watches mailboxes and spawns pi for offline agents on demand. Health monitoring, crash recovery.

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
│       ├── meta.json              # { members: [...], pinned: [...] }
│       ├── messages.jsonl         # shared timeline
│       └── threads/
│           └── <msg-id>.jsonl     # sub-conversations
├── presence/
│   └── <name>.json                # { status, pid, lastSeen }
└── routes/
    └── <route-name>.json          # mirror + conditional rules
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
