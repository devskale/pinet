# PiNet Handover — 2026-04-23

## What we built today

PiNet is an agent-to-agent communication network for pi. Agents get identities, DMs, and team chats, with a relay-backed sync system for cross-machine messaging. Today we went from "working prototype" to "clean, testable, usable."

## Commits today (10)

```
v0.2.0: ESM relay, sync stat fast-path, E2E handover tests
fix: replace deprecated url.parse() with WHATWG URL API
default models: glm-4.7/glm-5/glm-5.1/glm-5-turbo (zai provider)
setup instructions: split terminal/pi blocks with copy buttons
simplify: remove wizard from setup instructions, just /pinet Name@team
simplify setup: dev.sh writes relay.json, no wizard needed
fix: remove stray copyAll leftover causing dashboard JS syntax error
dashboard: 📋 button on project cards to show instructions anytime
cleanup: remove old scenario dirs, stale testbench, circular symlink
simplify: slash commands from 10 to 3, add discovery on login
dashboard chat: send messages to agents from the browser
fix: POST /api/mailbox and /api/messages routing bug
```

## What works

- **`./dev.sh`** — starts relay + dashboard, writes `relay.json`, seeds demo project
- **`/pinet Alice@build`** — login, no wizard needed
- **Dashboard** — http://localhost:8081, token `testlocal123`
  - Setup tab: create projects, get copy-paste instructions per agent
  - Messages tab: see agent conversations in real time
  - **Chat bar: send messages to agents from the dashboard** (NEW)
- **Discovery** — on login shows: who's online, unread counts
- **E2E tests** — 4/4 passing (`node --test test/handover.test.mjs`)
- **Test API** — `./test-api.sh` validates all HTTP endpoints
- **API logging** — relay logs `[HTTP] POST /api/mailbox/agenta`

## File structure

```
pinet/
├── pinet/                  ← the package
│   ├── index.ts            ← extension (447 lines, was 847)
│   ├── tools.ts            ← 7 LLM tools
│   ├── store.ts            ← file I/O
│   ├── read-state.ts       ← read pointers
│   ├── types.ts            ← types + constants
│   ├── relay.js            ← WebSocket relay + HTTP API
│   ├── sync.mjs            ← filesystem ↔ relay bridge
│   ├── dashboard.html      ← SPA
│   ├── test/
│   │   └── handover.test.mjs  ← 4 E2E tests
│   ├── dev.sh              ← start relay + dashboard
│   ├── test-api.sh         ← curl-based API validation
│   ├── TESTPLAN.md         ← full 124-test plan
│   └── QUICKSTART.md       ← 3-step guide
├── docs/                   ← design docs
├── scenarios/              ← todo-app scenario
└── teamsetups/team2basic/  ← alice + bob dirs (linked)
```

## What's open / next session

### Bug: dashboard → agent DMs not delivered

The POST routing bug is fixed in relay.js but needs end-to-end validation:
1. Restart `./dev.sh`
2. Start agenta: `cd teamsetups/team2basic/agenta && pi` → `/pinet agenta@build`
3. Run `./test-api.sh` — verify POST returns `{ ok: true }`
4. Check relay terminal shows `[dashboard → agenta] hello from test-api`
5. Check agenta's pi session receives the message

If the agent doesn't receive: the sync daemon may not be forwarding `from: 'dashboard'` messages correctly. Check `sync.mjs` echo filter — it checks `msg.agent === myAgent` to skip own messages. Dashboard sends `agent: 'Human'` so it shouldn't be filtered. But the sync daemon also filters outbound by `obj.from === myAgent` — the mailbox file write is `from: 'Human'`, which won't match, so the sync daemon won't re-send it. Good. But does it deliver via IPC?

**Debugging steps:**
- Check relay terminal for `[dashboard → agenta]` log
- Check sync daemon output (it logs `↓ Received`)
- Check `~/.pinet/mailboxes/agenta.mailbox.jsonl` for the written message
- Add more logging to sync.mjs if needed

### From TODO.md (Phase 1)

- [ ] 4. `pinet up` / `pinet down` — start/stop agents as child processes
- [ ] 5. `pinet status` / `pinet logs` / `pinet restart`
- [ ] 6. `/pinet brief` — send scenario file to all agents
- [ ] 8. End-to-end validation

### Test plan (TESTPLAN.md)

Layer 0 (store unit tests) is the highest priority next — 30 tests, validates the foundation. Then Layer 3 (extension + tools).

### Quick wins

- `pinet up` would make the demo flow: `./dev.sh` → `pinet up` → agents running
- Agent logs: `~/.pinet/logs/<agent>.log` — sync daemon already logs to stderr
- `test-api.sh` is ready to use for validation tomorrow

## How to pick up

```bash
# Start relay
cd pinet && ./dev.sh

# In another terminal: test the API
cd pinet && ./test-api.sh

# Start agents
cd teamsetups/team2basic/agenta && pi   → /pinet agenta@build
cd teamsetups/team2basic/agentb && pi   → /pinet agentb@build

# Validate dashboard chat works end-to-end
# Open http://localhost:8081 → click agenta → type a message → check agent's pi session
```
