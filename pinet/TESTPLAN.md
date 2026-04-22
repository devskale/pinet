# PiNet Test Plan

All tests use `node:test` (built-in, zero deps). Run with `node --test test/`.

## Layers

```
Layer 0: store.ts        — file I/O, JSONL, presence, teams
Layer 1: relay.js        — WebSocket protocol, auth, fan-out
Layer 2: sync.mjs        — filesystem ↔ relay bridge, IPC delivery
Layer 3: index.ts+tools  — extension lifecycle, tool execution, agent handover
```

Each layer only depends on layers below it. Tests run bottom-up.

---

## Layer 0: store.ts (unit)

No network, no relay, no pi. Pure file I/O against a temp directory.

Setup: override `PINET_DIR` to a temp dir, clean between tests.

### JSONL

| # | Test | What |
|---|------|------|
| 0.1 | `readJsonl` returns empty for missing file | `[]` |
| 0.2 | `readJsonl` returns empty for empty file | `[]` |
| 0.3 | `readJsonl` skips malformed lines | `{"a":1}\nBROKEN\n{"b":2}` → 2 entries |
| 0.4 | `readJsonl` with offset skips first N lines | 5 lines, offset 3 → 2 entries, no parse of first 3 |
| 0.5 | `appendJsonl` creates parent dirs | deep path works |
| 0.6 | `appendJsonl` appends to existing | 2 appends → 2 lines |
| 0.7 | `compactJsonl` keeps last N | 10 lines, compact(5) → 5, returns 5 |
| 0.8 | `compactJsonl` no-op under limit | 3 lines, compact(500) → returns 0 |
| 0.9 | `compactJsonl` uses atomic temp+rename | verify no `.tmp` files remain |
| 0.10 | `writeJson` / `readJson` round-trip | write `{a:1}`, read back `{a:1}` |
| 0.11 | `readJson` returns null for missing file | |
| 0.12 | `readJson` returns null for malformed JSON | |

### Presence

| # | Test | What |
|---|------|------|
| 0.13 | `writePresence` creates file with correct fields | name, status, pid, lastSeen |
| 0.14 | `readAllPresence` returns entries | 2 agents → 2 entries |
| 0.15 | `readAllPresence` cleans dead PIDs | live + dead PID → only live returned, dead file deleted |
| 0.16 | `readAllPresence` cleans stale heartbeat | lastSeen > 60s ago → cleaned |
| 0.17 | `readAllPresence` empty on missing dir | `[]` |

### Teams

| # | Test | What |
|---|------|------|
| 0.18 | `joinTeam` creates new team | meta.json written, members = [agent] |
| 0.19 | `joinTeam` adds agent to existing | members grows |
| 0.20 | `joinTeam` is idempotent | join same agent twice → members unchanged |
| 0.21 | `joinTeam` stores role | roles[agent] = "lead" |
| 0.22 | `readTeamMeta` returns null for missing team | |
| 0.23 | `readDeliveryMode` defaults to interrupt | new team, no delivery field |
| 0.24 | `setDeliveryMode` persists | set "digest", read back "digest" |
| 0.25 | `setDeliveryMode` returns false for missing team | |
| 0.26 | `readTeamMessages` with offset | 5 messages, offset 3 → 2 |

### Identity + Bindings

| # | Test | What |
|---|------|------|
| 0.27 | `writeIdentity` appends to identities.jsonl | 2 writes → 2 lines |
| 0.28 | `readBinding` returns null for unbound dir | |
| 0.29 | `writeBinding` + `readBinding` round-trip | name + teams preserved |
| 0.30 | `generateName` matches NAME_PATTERN | run 100 times |

---

## Layer 1: relay.js (integration)

Spawn relay on random port. Connect with raw WebSocket clients.

Setup: `before` starts relay, `after` kills it. Each test gets fresh state (relay restarts).

### Auth

| # | Test | What |
|---|------|------|
| 1.1 | Valid auth → welcome message | agent, network, teams fields correct |
| 1.2 | Bad network token → close 4001 | |
| 1.3 | No auth within timeout → close 4001 | wait 6s |
| 1.4 | No agent name → close 4015 | token ok, agent missing |
| 1.5 | Duplicate agent, different machine → close 4010 | |
| 1.6 | Same agent, same machine → old kicked (4002), new accepted | |
| 1.7 | Network full (100 agents) → close 4011 | hard to test, mock or lower limit |
| 1.8 | Bad team token → close 4012 | |
| 1.9 | Team full (5 agents) → close 4013 | |
| 1.10 | Too many teams (20) → close 4014 | |

### Fan-out

| # | Test | What |
|---|------|------|
| 1.11 | A sends append → B receives | verify from, path, lines |
| 1.12 | A sends append → A does NOT receive own message | excluded by sender |
| 1.13 | B sends append → A receives | reverse direction |
| 1.14 | A sends write → B receives | type=write |
| 1.15 | Three agents: A sends → B and C both receive | |
| 1.16 | Offline agent misses messages (no buffer in relay) | connect after disconnect → nothing waiting |

### Presence broadcasts

| # | Test | What |
|---|------|------|
| 1.17 | B connects → A sees agent_online | agent, machine, teams |
| 1.18 | B disconnects → A sees agent_offline | agent, teams |
| 1.19 | Team dissolved when last member leaves | |

### HTTP API

| # | Test | What |
|---|------|------|
| 1.20 | `GET /api/stats` → agents, teams, uptime | |
| 1.21 | `GET /api/messages/<team>` with token → messages | |
| 1.22 | `GET /api/messages/<team>` without token → 401 | |
| 1.23 | `GET /api/messages/<unknown>` → 404 | |
| 1.24 | `GET /api/messages?limit=1` → capped results | |
| 1.25 | `GET /api/messages?before=<ts>` → filtered | |
| 1.26 | `GET /api/mailbox/<agent>` → DMs | |
| 1.27 | `GET /api/conversations` → teams + dms | |
| 1.28 | `Authorization: Bearer <token>` works | |
| 1.29 | Dashboard serves HTML | content-type, login form |

### TLS (optional, needs certs)

| # | Test | What |
|---|------|------|
| 1.30 | wss:// auth + welcome | |
| 1.31 | wss:// message A→B | |
| 1.32 | HTTPS dashboard on same port | |

---

## Layer 2: sync.mjs (integration)

Fork sync daemon against a real relay. Use a temp `PINET_DIR`. Verify file → relay and relay → file paths.

Setup: start relay, write `relay.json`, fork `sync.mjs` with `PINET_AGENT_NAME`. Clean temp dir between tests.

### Outbound (file → relay)

| # | Test | What |
|---|------|------|
| 2.1 | New line in mailbox → sync sends to relay | append to own mailbox, verify relay receives |
| 2.2 | New line in team → sync sends to relay | own message detected |
| 2.3 | Other agent's lines NOT synced | append line with `from: other`, sync skips it |
| 2.4 | Multiple new lines → batched in one message | 3 appends before poll |
| 2.5 | File size unchanged → skip (stat fast-path) | no `lineCount()` called |
| 2.6 | New file after snapshot → picked up on rescan | create new team dir after connect |

### Inbound (relay → file + IPC)

| # | Test | What |
|---|------|------|
| 2.7 | Remote append (cross-machine) → written to local file | verify file contents |
| 2.8 | Remote append (same-machine) → NOT written | file unchanged, but IPC delivered |
| 2.9 | Remote append → IPC pinet-deliver sent to parent | process.send mock |
| 2.10 | Remote write → file updated (cross-machine) | |
| 2.11 | Remote write → IPC delivered | |
| 2.12 | Own agent's messages from relay → skipped | echo filter |

### Reconnection

| # | Test | What |
|---|------|------|
| 2.13 | Relay restart → sync reconnects | kill relay, restart, sync reconnects |
| 2.14 | Backoff increases | 500ms → 1s → 2s (spy on connect attempts) |

---

## Layer 3: extension + tools (unit with mock pi)

Mock `ExtensionAPI` to capture registered tools and commands. Call tool handlers directly.

Setup: create mock pi with `registerTool`, `registerCommand`, `sendMessage` stubs. Fresh temp dir per test.

### Login/logout lifecycle

| # | Test | What |
|---|------|------|
| 3.1 | `/pinet Alice@build` → login succeeds | presence file, identity logged, tools registered |
| 3.2 | `/pinet` (no args, no binding) → auto-generated name | |
| 3.3 | `/pinet` (no args, binding exists) → reclaims bound identity | |
| 3.4 | `/pinet off` → presence offline, tools reset | |
| 3.5 | `/pinet` when already logged in → "already logged in" | |
| 3.6 | `/pinet off` when not logged in → "not logged in" | |
| 3.7 | Name conflict (live PID) → rejected | |
| 3.8 | `--force` overrides name conflict | kicks old, logs in |
| 3.9 | Invalid name → rejected | "bob smith", "a@b" |
| 3.10 | Invalid team name → rejected | |
| 3.11 | Multiple teams: `/pinet A@build,test` → both joined | |
| 3.12 | `session_shutdown` → cleans up presence and sync daemon | |

### Tool: pinet_send

| # | Test | What |
|---|------|------|
| 3.13 | Send DM → mailbox file written | correct from, to, body, has id+timestamp |
| 3.14 | Send to offline agent → "queued" in response | |
| 3.15 | Send over 2000 chars → rejected | |
| 3.16 | Send when not logged in → "not logged in" | |

### Tool: pinet_mail

| # | Test | What |
|---|------|------|
| 3.17 | No DMs → "No DMs." | |
| 3.18 | 3 DMs → all listed, format correct | |
| 3.19 | Only unread DMs shown (read pointer works) | |

### Tool: pinet_list

| # | Test | What |
|---|------|------|
| 3.20 | Lists online agents with ● | |
| 3.21 | Lists offline agents with ○ | |

### Tool: pinet_team_send

| # | Test | What |
|---|------|------|
| 3.22 | Send to team → team jsonl written | |
| 3.23 | Send to team not in → rejected | |
| 3.24 | Rate limit: 2nd send within 5s → rejected | |
| 3.25 | Rate limit: 11th in 60s → rejected | |
| 3.26 | Over 2000 chars → rejected | |

### Tool: pinet_team_read

| # | Test | What |
|---|------|------|
| 3.27 | No unread → "No unread in #build." | |
| 3.28 | Unread from others only (self filtered) | |
| 3.29 | Team not in → rejected | |

### Tool: pinet_team_list

| # | Test | What |
|---|------|------|
| 3.30 | Lists teams with members, mode, unread | |
| 3.31 | No teams → "No teams." | |

### Tool: pinet_team_mode

| # | Test | What |
|---|------|------|
| 3.32 | Set digest → meta.json updated | |
| 3.33 | Invalid mode → rejected | |
| 3.34 | Team not in → rejected | |

### /pinet msg

| # | Test | What |
|---|------|------|
| 3.35 | `msg Bob Hello` → sends to shared team with @Bob prefix | |
| 3.36 | `msg Bob@build Hello` → explicit team | |
| 3.37 | Ambiguous (multiple shared teams) → shows options | |
| 3.38 | No shared team → rejected | |
| 3.39 | Not logged in → rejected | |

### /pinet wizard

| # | Test | What |
|---|------|------|
| 3.40 | 4 args: create team → relay.json saved, token generated | |
| 3.41 | team:token arg: join team → token stored | |
| 3.42 | No team arg: relay only → no teams in config | |
| 3.43 | Preserves existing teams when adding new | |
| 3.44 | Invalid team name → rejected | |

### IPC delivery (sync → pi.sendMessage)

| # | Test | What |
|---|------|------|
| 3.45 | Team message received → pi.sendMessage called with content | |
| 3.46 | Own team message filtered → pi.sendMessage NOT called | |
| 3.47 | DM received → pi.sendMessage called | |
| 3.48 | interrupt mode → triggerTurn: true | |
| 3.49 | digest mode → no triggerTurn (or triggerTurn: false) | |

---

## Smoke test: agent handover

One end-to-end test that validates the core value prop: **Alice tasks Bob, Bob does work, reports back.**

Does not use real pi. Mocks the LLM side. Tests the full message path through files and relay.

| # | Test | What |
|---|------|------|
| E2E.1 | Alice sends team task, Bob receives via sync+IPC, Bob replies, Alice receives | Full round-trip |
| E2E.2 | Alice DMs Bob, Bob reads with pinet_mail, Bob DMs back, Alice reads | DM round-trip |

---

## File structure

```
pinet/test/
├── helpers.ts           # temp dir, mock ExtensionAPI, relay spawn/stop
├── store.test.ts        # Layer 0
├── relay.test.mjs       # Layer 1
├── sync.test.mjs        # Layer 2
├── extension.test.ts    # Layer 3
└── handover.test.mjs    # E2E smoke test
```

## Running

```json
{
  "scripts": {
    "test": "node --test test/",
    "test:store": "node --test test/store.test.ts",
    "test:relay": "node --test test/relay.test.mjs",
    "test:sync": "node --test test/sync.test.mjs",
    "test:ext": "node --test test/extension.test.ts",
    "test:e2e": "node --test test/handover.test.mjs"
  }
}
```

## Priority

1. **Layer 0** (store) — foundation, fastest to write and run, catches regressions in compaction/offset logic
2. **Layer 1** (relay) — port from existing testbench, already proven
3. **Layer 3** (extension) — validates tool behavior, the most user-facing code
4. **E2E smoke** — one test, validates the whole stack
5. **Layer 2** (sync) — hardest to test (forked process, timing-dependent), least changed

## Estimated effort

| Layer | Tests | Effort |
|-------|-------|--------|
| Layer 0 | 30 | 2 hr |
| Layer 1 | 29 | 2 hr (mostly porting) |
| Layer 2 | 14 | 2 hr |
| Layer 3 | 49 | 3 hr |
| E2E | 2 | 1 hr |
| **Total** | **124** | **~10 hr** |
