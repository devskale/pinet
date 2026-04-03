# PiNet — Dev Journey

## What we built

A pi extension that enables agent-to-agent communication via files.

### Phase 1: Personal DMs ✅

- `/pinet <name>` login with identity, presence, mailbox watcher
- `pinet_send`, `pinet_mail`, `pinet_list` tools
- File-based messaging via `~/.pinet/mailboxes/<name>.mailbox.jsonl`
- Validated: two agents (FrontendDev + BackendDev) built a full-stack todo app

### Phase 2: Teams ✅

- `/pinet <name>@<team>` login — teams emerge from login, no separate create step
- `pinet_team_send`, `pinet_team_read`, `pinet_team_list` tools
- Shared team timeline via `~/.pinet/teams/<name>/messages.jsonl`
- Self-message filtering (skip own messages in team delivery)
- Validated: 4 agents (Master, BackendDev, FrontendDev, Tester) completed haiku challenge in team chat

## Architecture

```
~/.pinet/
├── identities.jsonl               # all-time login log
├── mailboxes/
│   └── <name>.mailbox.jsonl       # personal DMs (one per agent)
├── teams/
│   └── <team>/
│       ├── meta.json              # { members: [...] }
│       └── messages.jsonl         # shared timeline
└── presence/
    └── <name>.json                # { status, pid, lastSeen }
```

Single extension file: `pinet/index.ts` (~550 lines). Zero external dependencies.

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

## Setup for multi-agent work

```bash
# 1. Create workspaces
mkdir -p frontend backend tester mastermaster

# 2. Link extension into each
for dir in frontend backend tester mastermaster; do
  mkdir -p $dir/.pi/extensions
  ln -s $(pwd)/pinet $dir/.pi/extensions/pinet
done

# 3. Set model per workspace
echo '{"defaultModel":"glm-4.7"}' > frontend/.pi/settings.json
# ... repeat for each

# 4. Start tmux, one pane per agent
tmux new-session -s hands

# 5. In each pane: pi → /pinet Name@team
```

## Test results

### Test 1: Two agents, personal DMs
- BackendDev built Express API, FrontendDev built vanilla JS frontend
- Coordinated entirely via `pinet_send` / `pinet_mail`
- Full-stack todo app working end-to-end

### Test 2: Four agents, team chat
- Master, BackendDev, FrontendDev, Tester all in `@build` team
- Master assigned haiku challenge in team chat
- All agents responded with their lines autonomously
- Team timeline captured in `~/.pinet/teams/build/messages.jsonl`
- Self-message filtering worked — no infinite loops

## What's next (from docs/pinet.md)

- **Routing** — pipe, mirror, conditional message flows between agents and teams
- **Relay** — cross-machine via WebSocket, for agents on different computers
- **Agent daemon** — background process that watches mailboxes and spawns pi on demand
- **Threads** — sub-conversations within a team
- **Read receipts** — know when your message was seen
