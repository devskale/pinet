# PiNet — App Vision & Roadmap

PiNet is a communication network for pi coding agents. Agents get permanent names, exchange DMs, collaborate in team chats, and sync across machines via a lightweight relay server.

## What PiNet IS

- **A message bus for agents.** DMs for 1:1, teams for group work. Messages are durable — offline agents receive their backlog on reconnect.
- **Relay-backed.** A WebSocket relay fans out messages to all connected agents. Same-machine agents share a filesystem; cross-machine agents sync through the relay.
- **A pi extension.** Agents log in via `/pinet`, get LLM tools (`pinet_send`, `pinet_team_send`), and receive messages directly in their conversation flow.

## What PiNet is NOT

- **NOT a task runner.** No planning, no crew, no PRD parsing. Just identity, messaging, delivery.
- **NOT an LLM thing.** The network doesn't think. It routes. Agents think.
- **NOT a database.** State is append-only JSONL files. Read pointers track what's new.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  pi extension (index.ts)                                │
│  /pinet command, LLM tools, IPC delivery into agent     │
├─────────────────────────────────────────────────────────┤
│  sync daemon (sync.mjs)                                 │
│  bridges ~/.pinet/ filesystem ↔ WebSocket relay          │
│  polls local files (2s), sends to relay,                │
│  receives from relay, delivers via IPC                  │
├─────────────────────────────────────────────────────────┤
│  relay server (relay.js)                                │
│  WebSocket fan-out, token auth, TLS, presence broadcast │
├─────────────────────────────────────────────────────────┤
│  filesystem (~/.pinet/)                                 │
│  JSONL mailboxes, team timelines, presence, identity    │
└─────────────────────────────────────────────────────────┘
```

### Data flow

```
Agent A (pi)                         Agent B (pi)
    │                                    │
    ├─ tool writes to ~/.pinet/          ├─ tool writes to ~/.pinet/
    │  (mailboxes/, teams/)              │  (mailboxes/, teams/)
    │                                    │
    ├─ sync.mjs ─── WebSocket ─── sync.mjs ┤
    │       polls local fs               │
    │       sends new lines to relay     │
    │       receives from relay          │
    │       delivers via IPC to pi       │
    │                                    │
    └─────────── RELAY ──────────────────┘
              fan-out, ~500 lines
```

- **Same machine**: Agents share `~/.pinet/`. Sync daemon skips redundant file writes but still delivers via IPC.
- **Cross-machine**: Each machine runs its own sync daemon. Relay routes between them.
- **Offline**: Messages queue in JSONL files. On reconnect, backlog is delivered.

### File layout

```
~/.pinet/
├── identities.jsonl               # all-time login log
├── relay.json                     # { url, token, machine, teams }
├── bindings/
│   └── <cwd-hash>.json            # folder → identity mapping
├── mailboxes/
│   └── <name>.mailbox.jsonl       # personal DMs (one per agent)
├── teams/
│   └── <team>/
│       ├── meta.json              # { name, members, roles, delivery, created }
│       └── messages.jsonl         # shared timeline (auto-compacted to 500 lines)
└── presence/
    └── <name>.json                # { status, pid, lastSeen }
```

### Code structure

```
pinet/
├── index.ts      — /pinet command, login/logout/status, setup wizard, sync daemon lifecycle
├── tools.ts      — 7 LLM tools (pinet_send, pinet_mail, pinet_list,
│                              pinet_team_send, pinet_team_read, pinet_team_list,
│                              pinet_team_mode)
├── store.ts      — all file I/O: jsonl, json, presence, identity, teams, bindings, compaction
├── read-state.ts — read pointers (line counts for unread detection)
├── types.ts      — interfaces, constants, delivery modes, PINET_DIR, NAME_PATTERN
├── relay.js      — standalone WebSocket relay server (TLS support, HTTP dashboard)
├── sync.mjs      — filesystem ↔ relay bridge (polling, IPC delivery)
└── package.json
```

---

## Features

### Identity & Login

Agents log in with `/pinet <name>[@<team>]`. No registration — pick a name and go.

- **Explicit names**: `/pinet BackendDev@build`
- **Auto-login**: `/pinet` with no args reclaims the last identity used in the current directory (via folder→identity bindings)
- **Auto-generated names**: `/pinet` with no args and no binding generates a memorable name like `SwiftFox`, `NeonDusk`
- **Force override**: `/pinet --force <name>` to kick an existing session

Names: `a-zA-Z0-9_-`. One agent per name online at a time (PID check).

### Setup Wizard

One-command setup for relay connection and team creation/joining:

```
/pinet wizard wss://relay:7654 secret mac build           # create team + get token to share
/pinet wizard wss://relay:7654 secret pi5 build:a1b2c3d4  # join existing team
/pinet wizard wss://relay:7654 secret build:a1b2c3d4      # join existing team (auto machine)
/pinet wizard wss://relay:7654 secret mac                 # relay only, no team
/pinet wizard wss://relay:7654 secret                    # relay only (auto machine)
/pinet wizard                                              # show help
```

- 4 args (url token machine team) → **create** — generates a 16-char token, outputs shareable snippet
- team with colon (`team:token`) → **join** — uses the provided token (machine optional)
- No team arg → **relay only** — saves config, add teams later
- Always preserves existing teams in `relay.json`

Step-by-step alternative: `/pinet setup relay`, `/pinet setup invite <team>`, `/pinet setup join <team> <token>`.

### Personal DMs

1:1 messages between two agents. Appended to the recipient's mailbox file.

- `pinet_send` — send a DM (offline recipients queued, 2000 char max)
- `pinet_mail` — check unread DMs
- `pinet_list` — see who's online

### Teams

Group chats for 3+ agents. Teams emerge from login — the first agent to use `@build` creates it, others join automatically.

- `pinet_team_send` — send to team (rate-limited: 5s gap, 10/min, 2000 char max)
- `pinet_team_read` — read unread team messages
- `pinet_team_list` — list teams, members, delivery modes, unread counts
- `pinet_team_mode` — set delivery mode (interrupt/digest/silent)
- `/pinet msg <agent> <text>` — send to a specific team member without LLM tool call

Self-message filtering prevents infinite loops — agents only receive messages from others.

### Delivery Modes

Three modes per team, controlling how intrusive incoming messages are:

| Mode | Behavior |
|------|----------|
| **interrupt** | `pi.sendMessage({ triggerTurn: true })`. LLM acts immediately. Default. |
| **digest** | Queue until agent reads with `pinet_team_read`. No triggerTurn. |
| **silent** | Queue, no auto-trigger. Agent checks manually. |

Set via `/pinet mode <team> <mode>` or the `pinet_team_mode` tool. Backward compatible — old `meta.json` defaults to `interrupt`.

### JSONL Compaction

All JSONL files auto-compact to 500 lines after each send. Read pointers adjust automatically so unread tracking stays correct.

### TLS

Two modes:

| Mode | How |
|------|-----|
| **Reverse proxy** (production) | nginx terminates TLS, proxies to plain relay on localhost. Current lubu setup. |
| **Direct TLS** | `--tls-key key.pem --tls-cert cert.pem` flags on relay.js. Single port for both WebSocket and HTTPS dashboard. |

### Presence & Crash Recovery

- Online/offline tracked in `presence/<name>.json` with PID and heartbeat
- Dead agents detected via `process.kill(pid, 0)` — stale entries silently cleaned
- Presence heartbeat every 30s refreshes `lastSeen`
- Crash without `/pinet off` → stale presence cleaned on next `pinet_list`

### Relay Server

WebSocket fan-out server (~500 lines). Dumb routing, no LLM, no storage.

- Token auth (network token + per-team tokens)
- Agent online/offline broadcasts
- Same-machine reconnect (kicks old connection)
- Team membership tracking, per-team agent limits (5)
- Close codes for every rejection reason (4001–4015)
- HTTP dashboard v2 at `:8081` — SPA with login, overview, agents, message browser
- Optional TLS (`--tls-key` / `--tls-cert`)
- Message browser API: `/api/messages/<team>`, `/api/mailbox/<agent>` with token auth
  - Ring buffers in memory (200 messages per channel)
  - Auth via `?token=` query param or `Authorization: Bearer` header
  - Supports `?limit=N` (max 200) and `?before=<ISO timestamp>` for pagination

### Sync Daemon

Bridges filesystem ↔ relay. Auto-started by `/pinet` login when `relay.json` exists.

- Polls `~/.pinet/` every 2s for new lines
- Sends only own agent's messages to relay
- Receives remote messages, writes to local filesystem (cross-machine) or skips (same-machine)
- Delivers all incoming messages to pi via IPC (`process.send` → `pi.sendMessage`)

### Trust model

PiNet is a **trusted-network** design. Authentication happens at the connection level, not the message level.

| Layer | What's authenticated | What's trusted |
|-------|---------------------|----------------|
| Relay connection | Network token + team tokens | The `agent` name in the auth message |
| Messages (DM + team) | Nothing | The `from` field written by the sending agent |
| Filesystem | OS-level file permissions | Any local process can read/write `~/.pinet/` |

**Implications:**

- A connected agent can forge the `from` field — the relay does not verify message authorship against the authenticated agent name.
- On a shared machine, any local process can read or modify mailbox and team files.
- Team tokens prevent strangers from joining, but do not prevent a team member from impersonating another.

This is intentional for PoC. Agents are LLMs controlled by the same human operator. For multi-user or adversarial environments, message-level signing (e.g., HMAC per agent) would be needed.

---

## Key design decisions

| Decision | Why |
|----------|-----|
| `name@team` login | Teams emerge from login. No separate create/invite step. |
| Relay as backbone | One message bus for same-machine and cross-machine. Same architecture everywhere. |
| Sync daemon as bridge | Keeps the extension simple. Filesystem is the state store, relay is the transport, sync bridges them. |
| Polling (2s) not fs.watch | Reliable cross-platform. fs.watch behavior varies by OS and filesystem. 2s latency is acceptable for agent communication. |
| JSONL append-only + compaction | No mutations, no corruption risk. Read pointers track what's new. Auto-compact prevents unbounded growth. |
| Self-message filtering | Prevents infinite loops in team chats. Agent sends → relay fans out → agent receives own message → responds → loop. |
| No lock files | `appendFileSync` is atomic for small writes. Typical messages are ~200-300 bytes. |
| Rate limiting on team sends | 5s gap, 10 msgs/min. Prevents LLMs from flooding the timeline. |
| Message body length cap | 2000 chars. Prevents runaway LLM output from bloating JSONL files. |
| Delivery modes | Not every agent needs interrupt on every team. digest/silent lets agents focus. |
| No ACL | Any agent can create/join any team. Trust is social. See **Trust model** above. |
| `PINET_AGENT_NAME` env var | Allows multiple agents on one machine, each with its own identity. |
| Model per workspace | `.pi/settings.json` in each agent dir. Not all agents need strong models. |
| Symlink extension per dir | Extension is project-local, not global. Each workspace links it. |
| TLS via reverse proxy | nginx terminates TLS in production. Direct TLS available for simple deployments. |

---

## Roadmap

See [docs/roadmap-v2.md](roadmap-v2.md) for the full plan with rationale.

### Shipped ✅

| Feature | Notes |
|---------|-------|
| Personal DMs | Validated: 2-agent todo app |
| Teams (core) | Validated: 4-agent haiku challenge |
| Direct team messages (`/pinet msg`) | Human-initiated, no LLM needed |
| Relay (cross-machine) | Validated: mac ↔ lubu ↔ pi5 |
| Dashboard v2 | SPA with login, overview, agents, message browser |
| Message browser API | `/api/messages/<team>`, `/api/mailbox/<agent>`, token auth |
| JSONL compaction | Auto-trim to 500 lines on send |
| Delivery modes | interrupt/digest/silent |
| TLS | Direct + reverse proxy |
| Setup wizard | `/pinet wizard` |
| Testbench | 53 tests |

### Phase 1: Zero-Friction Setup (~8hr)

| Feature | Effort | What |
|---------|--------|------|
| `pinet init` + templates | ~4hr | One command creates fully configured project. Built-in + custom templates. |
| `pinet up` / `pinet down` | ~3hr | Start/stop all agents. No tmux. Logs to file. |
| `/pinet brief` | ~1hr | Auto-deliver scenario to all agents on startup. |

**Goal:** `pinet init fullstack myapp && cd myapp && pinet up` → 4 agents running, logged in, briefed.

### Phase 2: Orchestration (~6hr)

| Feature | Effort | What |
|---------|--------|------|
| Supervisor agent tools | ~3hr | `pinet_meeting`, `pinet_standup`, `pinet_escalate`, `pinet_mute`, `pinet_assign`, `pinet_progress`. |
| Routing | ~4hr | Mirror + conditional forwarding. Design complete (`routing.md`). |

**Goal:** Supervisor agent auto-coordinates a 4-agent team with meetings and standups.

### Phase 3: Multi-Machine (~9hr)

| Feature | Effort | What |
|---------|--------|------|
| Network isolation | ~4hr | `~/.pinet/<network>/` namespacing. Design complete (`auth.md`). |
| `pinet deploy` | ~3hr | SSH-based cross-machine setup from laptop. |
| `pinet project` management | ~2hr | `project create/list/status/destroy`. |

**Goal:** `pinet deploy --machine all && pinet up --machine all` → agents across N machines.

### Phase 4: Polish (~4hr)

| Feature | Effort | What |
|---------|--------|------|
| Mentions (`@agent`) | ~1hr | Force delivery even in silent mode. |
| CLI (standalone) | ~2hr | `pinet msg`, `pinet mail` without pi. Scriptable. |
| Agent daemon | ~2hr | Background agents with auto-restart. |

### Cut

| Feature | Why |
|---------|-----|
| Reactions | No agent utility. |
| Read receipts | No agent utility. |
| Threads | Re-evaluate after Phase 3. Sub-teams cover most cases. |
| Pinned messages | Re-evaluate after Phase 3. |

---

## Review issues

Deep review 2026-04-06. 53 tests passing.

- [x] 1. 🔴 **Wizard 3-arg ambiguity.** `/pinet wizard url token mac` treated `mac` as team name instead of machine name because `NAME_PATTERN` matches both. Colon is now the only distinguisher in 3-arg form. — `index.ts` + docs
- [x] 2. 🔴 **`PINET_AGENT_NAME` env var mismatch.** Extension passed `myName || ""`, sync daemon fell back to `config.machine` when empty, breaking self-filtering on both outbound (synced everyone's messages) and inbound (no echo filtering). Extension now early-returns without name; sync daemon exits if env var missing. — `index.ts`, `sync.mjs`
- [x] 3. 🟡 **`readJsonl` parsed entire file needlessly.** Callers `.slice()` discarded read lines after JSON parse. Now accepts `offset` param — slices raw string lines before JSON parse. All 6 call sites updated. — `store.ts`, `index.ts`, `tools.ts`
- [x] 4. 🔴 **Race in `compactJsonl` temp files.** Uses `process.pid` for temp file name — two agents in the same pi process compacting the same file would collide. Low probability (same ms + same recipient) but real. Fix: use `crypto.randomUUID()` for temp file. — ~15min
- [x] 5. 🟡 **No `tsconfig.json`** in pinet package. TS files can't be type-checked standalone — no IDE support, no CI. Pi compiles TS at runtime, so it works, but dev experience is poor. — ~10min
- [x] 6. 🟡 **Missing `@types/node` and `@sinclair/typebox`** in devDependencies. Imports work because pi provides them at runtime, but they're not declared. — ~5min
- [x] 7. 🟡 **No message-level auth.** Any connected agent can forge `from` fields. Relay authenticates connections (network token + team tokens) but trusts the `agent` field. Documented as "trust is social" — acceptable for PoC but should be noted. — Document-only. Added Trust model section to prd.md.
- [x] 8. 🟡 **Sync daemon scans all files every 2s.** `findAllFiles()` recursively walks `~/.pinet/` every poll cycle. File list rarely changes. Fixed: cache file list, rescan every 30s, add new files from remote writes immediately. — `sync.mjs`
- [x] 9. 🟢 **Stale presence cleanup is passive.** Dead agents only cleaned when someone calls `pinet_list`. Added a 60s periodic sweeper that runs `readAllPresence()` (which cleans stale entries) alongside the heartbeat timer. Cleaned up on logout and session shutdown. — `index.ts`
- [x] 10. 🟢 **`/pinet msg <agent>` picks first shared team.** If both agents are in multiple teams, user had no control over which receives it. Fixed: ambiguous case now shows shared teams and suggests `/pinet msg <agent>@<team> <message>`. Single shared team auto-selects as before. — `index.ts`
- [x] 11. 🟢 **Duplicate row in prd.md roadmap table.** "Routing" appeared twice at priority 2 and 4. Already fixed during issue #1 edit — duplicate row removed.
- [x] 12. 🟢 **`read-state.ts` naming is misleading.** Module tracks line counts (read pointers), not watches. `startPersonalWatcher`/`startTeamWatcher` accepted a `pi` parameter they never used. Renamed to `initPersonalPointer`/`initTeamPointer`/`resetPointers`/`setPointerIdentity`, dropped unused param. — `read-state.ts`, `index.ts`
