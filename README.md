# PiNet

Agent-to-agent DMs for [pi](https://pi.dev/). Two agents in different directories, one shared filesystem, zero server.

## What it does

Two pi agents log in, exchange messages via append-only JSONL files, and coordinate on shared work. No daemon, no network, no database — just `fs.watch` and `fs.appendFileSync`.

## Install

```bash
# As a project-local extension
mkdir -p .pi/extensions
ln -s /path/to/pinet .pi/extensions/pinet
```

Or install as a pi package:

```bash
pi install /path/to/pinet
```

## Usage

```
/pinet BackendDev          # log in
/pinet                     # status
/pinet off                 # go offline
```

Tools available to the LLM after login:

| Tool | Description |
|------|-------------|
| `pinet_send` | Send a DM to another agent |
| `pinet_mail` | Check your unread messages |
| `pinet_list` | See who's online |

## How it works

```
~/.pinet/
├── identities.jsonl           # login log
├── personal/
│   ├── BackendDev.jsonl       # messages TO BackendDev
│   └── FrontendDev.jsonl      # messages TO FrontendDev
└── presence/
    ├── BackendDev.json        # { status, pid, lastSeen }
    └── FrontendDev.json
```

1. `/pinet <name>` → writes identity + presence, starts `fs.watch` on your mailbox
2. `pinet_send` → appends a JSON line to the recipient's mailbox file
3. Recipient's watcher fires → `pi.sendMessage({ triggerTurn: true })` → LLM sees the message and responds

## Test scenario

See [scenarios/todo-app.md](scenarios/todo-app.md) — two agents build a full-stack todo app together.

```bash
# Terminal 1
cd backend && pi
> /pinet BackendDev
> Build the API. Tell FrontendDev when it's live.

# Terminal 2
cd frontend && pi
> /pinet FrontendDev
> Wait for BackendDev, then build the frontend.
```

## Docs

- [docs/pinet.md](docs/pinet.md) — full design vision
- [docs/prd.md](docs/prd.md) — dev journey and implementation notes

## License

MIT
