# PiNet Teams — Design

## What

Group chats for 3+ agents. One shared message timeline, everyone sees everything.

## Login: `name@team`

The key UX. Teams are emergent from login — no separate "create team" step.

```
/pinet Master@build             # login as Master, create/join team "build"
/pinet BackendDev@build         # login as BackendDev, join team "build"
/pinet FrontendDev@build        # login as FrontendDev, join team "build"
/pinet Tester@build             # login as Tester, join team "build"
```

### What happens on `/pinet <name>@<team>`

1. Same as personal login: identity, presence, mailbox watcher, personal tools
2. **Plus**: join team `<team>` — create `~/.pinet/teams/<team>/` if it doesn't exist, add yourself to `meta.json` members
3. **Plus**: start watching team `messages.jsonl`
4. **Plus**: register team tools (`pinet_team_send`, `pinet_team_read`, `pinet_team_list`)

### Team creation is implicit

No explicit `pinet_team_create`. The first agent to log in with `@build` creates it. Others join. Master doesn't need a special role — anyone can start a team.

### Login forms

```
/pinet BackendDev               # personal DMs only, no team
/pinet BackendDev@build         # personal DMs + team "build"
/pinet BackendDev@build,review  # personal DMs + two teams
/pinet                           # status (if already logged in)
/pinet off                       # leave all teams + go offline
```

### Why `name@team`

- **Fewer steps** — one command instead of login + create + invite
- **Emergent** — teams form when agents show up
- **Memorable** — `BackendDev@build` reads like an email or Slack handle
- **No ACL** — anyone can join any team. Trust is social.

## File layout

```
~/.pinet/
├── mailboxes/
│   └── BackendDev.mailbox.jsonl       # personal DMs
├── teams/
│   └── build/
│       ├── meta.json                  # { name, members: [...], created }
│       └── messages.jsonl             # shared timeline
└── presence/
    └── BackendDev.json
```

One folder per team. `meta.json` is the roster. `messages.jsonl` is the chat.

## Message format

```json
{"id":"uuid","from":"Master","team":"build","body":"BackendDev: build the API. FrontendDev: wait.","timestamp":"..."}
```

Same shape as personal messages, plus `team` field.

## Concurrency

Multiple agents append to the same `messages.jsonl`. On macOS, `appendFileSync` with writes under 512 bytes (PIPE_BUF) is atomic. Typical message is ~200-300 bytes. No lock file needed for PoC.

## Self-message filtering

When Agent A sends to a team, Agent A's own watcher fires too. Must filter: only deliver messages where `from !== myIdentity.name`. Without this: send → see own message → respond → infinite loop.

## Tools

### Personal tools (registered on any login)

| Tool | What |
|------|------|
| `pinet_send` | DM another agent |
| `pinet_mail` | Check personal DMs |
| `pinet_list` | See who's online |

### Team tools (registered only when logged in with `@team`)

| Tool | What |
|------|------|
| `pinet_team_send` | Send message to team |
| `pinet_team_read` | Read unread team messages |
| `pinet_team_list` | List teams you're in and their members |

## Watcher architecture

Each logged-in agent has:
- 1 personal mailbox watcher (existing, unchanged)
- N team message watchers (one per team in `@team1,team2`)

All watchers are per-process. On logout, all stop.

## Agent models

Not every agent needs a frontier model. PiNet is model-agnostic — the network routes messages regardless. But the setup routine should assign models intentionally.

| Role | Model tier | Why |
|------|-----------|-----|
| Master | strong (e.g. claude-4-sonnet, gpt-5) | Reason about architecture, decompose tasks, review code |
| BackendDev | mid (e.g. glm-5.1) | Code generation, API design |
| FrontendDev | mid (e.g. glm-5.1) | HTML/CSS/JS — well-solved domain |
| Tester | fast/cheap (e.g. glm-4.7) | Simple validation, run assertions |

Model is set per agent in each workspace's `.pi/settings.json`:

```json
// mastermaster/.pi/settings.json
{ "defaultModel": "claude-4-sonnet" }

// frontend/.pi/settings.json  (and backend/)
{ "defaultModel": "glm-5.1" }

// tester/.pi/settings.json
{ "defaultModel": "glm-4.7" }
```

## Setup routine for a multi-agent task

```
1. Human writes a spec (GOAL.md or similar)
2. Decide agent roles and models
3. Symlink the extension into each workspace:
   for dir in frontend backend tester mastermaster; do
     mkdir -p $dir/.pi/extensions
     ln -s $(pwd)/pinet $dir/.pi/extensions/pinet
   done
4. Set model per workspace in .pi/settings.json
5. Start N agents in N tmux panes
6. Each agent logs in: /pinet Name@team
7. Teams emerge — first agent creates, others join
8. Master reads the spec, sends assignments via pinet_team_send
9. Workers report progress in team chat
10. Workers can DM each other for 1:1 side conversations
```

The spec is the source of truth. Team chat is coordination. Personal DMs are for side conversations.

## Validation scenario (4 agents, 4 panes)

Keep it minimal — we're testing PiNet, not building real software.

| Pane | Dir | Agent | Model |
|------|-----|-------|-------|
| 1 | frontend/ | FrontendDev@build | glm-4.7 |
| 2 | backend/ | BackendDev@build | glm-4.7 |
| 3 | mastermaster/ | Master@build | glm-4.7 |
| 4 | tester/ | Tester@build | glm-4.7 |

**Challenge:** Write a haiku about coding, one line per agent, assembled by Master.

Expected flow:
1. Master in team: "Each of you write one line of a haiku (5-7-5 syllables). BackendDev: line 1. FrontendDev: line 2. Tester: line 3."
2. BackendDev in team: "Bugs crawl through the night"
3. FrontendDev in team: "Syntax highlights the dark screen"
4. Tester in team: "Tests pass, dawn breaks free"
5. Master in team: "Here's our haiku: [assembles lines]. Done! ✅"
6. Master DMs Tester: "Nice line!" (validates personal DM alongside team)

This validates:
- `name@team` login syntax
- Emergent team creation
- Multi-agent team conversation
- Self-message filtering (each agent sees others' messages, not own)
- Personal DMs alongside team chat
- All 4 agents responding autonomously
