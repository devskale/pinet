# PiNet 2.0 — PRD

> A self-hosted **webapp** that is the hub for humans *and* pi agents to run projects as a team. It holds **issue files** (a kanban) and **per-project permissions**; agents pick up, work, and move issues across the board; an admin coordinates. **The webapp holds issue files only — never code or repos — and does zero git.**

This productizes a system that already works — kontext.one's `issues` kanban (file-based, issue-per-markdown-file, columns-as-folders) — and lifts it from a CLI-only sidecar into a **stateful webapp** with a UI, a user/agent registry, login, and permissions. The webapp reuses the kontext.one issue format as its store; agents and humans are its clients.

See [`inspirations.md`](inspirations.md) for the full lineage: jot (the form), paperclip (the mental model), the agent-kanban field (mechanics), pinet 1.0 (the cautionary tale), your toj fork (conventions), and your `skale-skills` extensions (implementation patterns).

---

## What it IS

- **A webapp — the hub.** It holds state and serves two equal client groups over the same data: humans (web UI) and agents (HTTP API).
- **Issue content = files on disk; relational state in an embedded DB.** Issue bodies live as markdown files (kontext.one format, grep-able, portable); users, permissions, sessions, projects, and the board index live in a DB. No DB server for v0 — embedded only (SQLite-class).
- **A board per project.** Projects group issues + members + an admin + permissions.
- **Login + per-project permissions** for both agents and users.

## What it is NOT

- **It does not hold code or repos.** No clone/pull/push/branch/PR/diff, ever. Branches and PRs are the agents' business, done in their own local repos. (A branch name may appear as plain text inside an issue — opaque to the webapp.)
- **No code execution, no scheduling, no server-push wake.** The webapp never pokes agents; agents wake *themselves* on their own heartbeat (see Timing model).
- **No messaging layer.** The board is the coordination surface; there is no separate DM/chat. (Explicit rejection of pinet 1.0's center of gravity.)
- **No DB ops.** Embedded DB only (SQLite-class) alongside the issue files — nothing to run or administer.

---

## The model

### What the webapp holds (and only this)

```
<data-dir>/
  pinet.db                        # users, projects, members, permissions, sessions, board index
  <project>/                      # one project = one board
    issues/
      backlog/   active/   review/     # live columns (issue markdown files)
      archive/   cancelled/            # terminal sinks
```

Issue **content** is files; **relational state** (users, permissions, sessions, the board index) is the DB. It holds neither repos nor code.

### Issue = one markdown file (kontext.one format, reused)

```markdown
---
state: OPEN                  # OPEN → WIP → FOR_REVIEW → DONE, + CANCELLED
from: mac@backend
to:   mac@frontend
date: 2026-07-10
module: webapp-ui
---
## Task
Render the login form against the agreed contract.

## Context
- POST /api/login {user,pw} → {token}
```

- **Moving a card** = `mv` the file between column dirs + flip `state`.
- **`state` ↔ column** is 1:1: `OPEN=backlog`, `WIP=active`, `FOR_REVIEW=review`, `DONE=archive`, `CANCELLED=cancelled`.

### Identity = `machine@scope`

`machine` from `~/.handoff-me` (fallback `hostname -s`; already resolved by your `statusline` extension). **`scope`** is the `@`-part:
- **default** = project name (the default agent for that project)
- **override** = a role (`backend` / `frontend` / `orchestrator`) when several agents share a project

Agents and users register this handle in `users.json` and **log in** to get a session/token. The `module:` field still records the target repo/package (as text).

### Assignment = the `to:` field; pull = `todo`

An issue is "assigned" by setting `to: <actor>`. An agent pulls its work (`issues where to == me`), then starts it. No dispatcher, no server-push — workers pull via `todo` and self-wake on their heartbeat when new work lands.

---

## The webapp (the hub)

- **Web UI (humans):** project switcher, board with drag-to-move (writes the file move + state flip), issue editor, user/permission management.
- **HTTP API (agents + scripts):** the same verbs the CLI exposes, over HTTP — list/show/create/start/review/set/triage/overview.
- **Auth:** login/logout for agents *and* users; **per-project permissions** (admin / member). Agents authenticate via a token obtained at login (credgoo-friendly, toj convention).
- **No new state beyond the issue files.** Every action is a read/write of those files.

---

## Agent surface: skill/CLI (workhorse) + extension — no MCP

**The skill/CLI is the workhorse** — all the verbs, the surface humans/scripts use too — and it talks to the webapp's HTTP API:

```
issues board / ls / show / new / start / review / triage / set / cancel / archive / mine / todo / done / overview
```

Shipped as `@devskale/<name>` with a short CLI binary (toj convention).

**The complementary pi extension** layers on for agents, composing patterns you already ship in `skale-skills/extensions` (`heartbeat.ts`, `statusline.ts`). Four jobs:

1. **`login [scope]`** — resolve + bind identity (`machine@scope`), authenticate to the webapp, store the token, start the heartbeat.
2. **get scope** — determine the `@scope` part and which project/board.
3. **get access to issues** — register the workhorse verbs as pi tools (`issue_todo/list/show`, `issue_new/start/review`, `issue_set/triage`, `issue_overview`) so the LLM calls them directly; each hits the API.
4. **get heartbeat** — the self-tick (see Timing model).

Built with `typebox` + `defineTool`, `pi.registerCommand` + `pi.registerTool` (dual surface), lifecycle hooks (`session_start/tree/compact/shutdown`), config persisted via `pi.appendEntry`, timers `.unref()`'d. Targets pi ≥ 0.79. **No MCP.**

---

## Timing model: ticks, pull, wake (no server-push wake)

The webapp is passive about *driving* agents — it never pushes into them. The rhythm is **agent-initiated pull on a tick**. "No wake" means specifically *no server-push wake* (the pinet 1.0 trap).

| Concept | What | Here |
|---|---|---|
| **Tick** | recurring cadence | the extension's heartbeat timer (default ~60s) + a pull at every turn start |
| **Pull** | read the board | API reads: `todo` (to:me), `mine`, `overview`, `show` |
| **Wake** | start a turn | two sources only: **(a) human kick**, **(b) self-tick** — heartbeat sees new to:me work → `pi.sendUserMessage(msg, { deliverAs: "followUp" })` |

### Heartbeat: 0 changes = no work

Each tick asks the webapp **what changed since a cursor** — the webapp holds the files, so it tracks this authoritatively:

```js
setInterval(() => {
  const delta = await api.get(`/projects/${project}/issues/changes?since=${cursor}`);
  if (delta.isEmpty) return;                    // 0 changes → done. one cheap call, no wake, no tokens
  const mine = delta.filter(to == me);
  if (mine.length) pi.sendUserMessage(`📥 ${mine}`, { deliverAs: "followUp" });
  cursor = delta.cursor;
}, TICK_MS);
```

Steady state (nothing happened): one cheap API call, **zero wake, zero tokens.** A turn fires only when there's new work addressed to me. Per-agent on/off (mute to drive an agent manually).

---

## Orchestrator (admin as planner)

The orchestrator is **not a runtime** — it's the **admin role doing its planning job**, played by a human or an agent, working entirely through the board:

- **Overviews** — reads the whole board (open/WIP/stale, per-worker load, what's in review).
- **Issues** — decomposes a goal/brief into concrete issues and addresses them (`issue_new … <to>`). *Issuing* = setting `to:`.
- **Tracks** — notices stuck WIP, reassigns, closes done work; re-points `to:` to hand work back.

Pull and orchestrate coexist: workers pull via `todo`; the orchestrator hard-assigns via `to:`. The loop closes itself because each worker's heartbeat sees its new `to:me` issue and self-wakes. Dependencies: the orchestrator specifies the **contract** up front (so workers parallelize) plus notes agents read; formal `blocked-by` is deferred. Needs one verb beyond the workhorse: `issue_overview` (stale-WIP + per-actor load).

**Boundary:** orchestrator-as-planner (think + write issues) is in scope. Orchestrator-as-scheduler (wake agents on a clock, auto-reassign) is **deferred** — that line would re-introduce server-side driving.

---

## What PiNet 2.0 adds over kontext.one

| kontext.one has | PiNet 2.0 adds |
|---|---|
| File kanban + columns + issue format | **Adopted unchanged** as the webapp's store |
| pi skill + CLI agent surface | **Adopted**, now pointed at the webapp API |
| Identity inferred from `machine@module` strings | A real **user/agent registry + login + per-project permissions** |
| CLI only (no UI) | A **webapp** (UI + API) as the hub |
| Cross-machine via file sync | **Cross-machine via HTTP** to one webapp — no relay, no sync |
| One-project-per-metarepo | **Multi-project** in one app |

---

## Locked decisions (the spine)

1. **Board, not bus.** Issue-on-kanban is the atom of work — not a chat message.
2. **The webapp is the hub.** It holds **issue files** (content) + an **embedded DB** (users, permissions, sessions, board index). It does **not** hold code/repos; it does **no git**.
3. **Two equal client groups over one hub:** humans (UI) + agents (skill/CLI + extension → HTTP API). **No MCP.**
4. **Login/logout + per-project permissions** for agents and users.
5. **Identity = `machine@scope`.**
6. **Cross-machine = HTTP to the webapp** (no relay, no file-sync — the pinet 1.0 trap, avoided).
7. **Wake is agent-local self-tick only** — heartbeat → `pi.sendUserMessage({deliverAs:"followUp"})`; **no server-push**.
8. **Self-hosted, `@devskale/` package, short CLI, credgoo for keys** (toj form factor).

## Deferred — evaluate on the go

- **Extension scope** — ship the four jobs (login/scope/access/heartbeat) first; richer orchestration tools graduate in.
- **Registry shape** — explicit `users.json` vs derived (lean: explicit, light).
- **Columns configurable?** (lean: ship the fixed 5; configurable later.)
- **Extra issue fields** — priority/labels (lean: none for now; `module` + `to:` suffice).
- **Webapp live updates** — start with the change-endpoint poll; websocket later.
- **External scheduler / cron-waking headless agents, goal hierarchy, roles, budgets, orchestrator-as-scheduler** — out of v0 (paperclip territory).

## Open questions

- **Name.** "PiNet 2.0" is a placeholder; needs a short `@devskale/<name>` + CLI binary (toj-style). TBD.
- **Where does the webapp run?** One host (a server like amp/pi5, or your laptop). Agents on other machines hit it over HTTP.
- **Migration.** Point the webapp at / import an existing `~/code/handoffs/<project>/issues/` so current boards come along.
- **DB choice.** SQLite (embedded, lean) vs Postgres (only if multi-writer/multi-host later). Issue content stays files either way.

---

## References

- [`inspirations.md`](inspirations.md) — jot, paperclip, agent-kanban field, pinet 1.0, toj, skale-skills extensions.
- **Proven reference implementation:** `~/code/kontext.one/.pi/skills/issues/SKILL.md` + `~/code/kontext.one/.pi/scripts/issues` + `~/code/handoffs/kontext.one/issues/`.
- **Extension patterns to reuse:** `~/code/skale-skills/extensions/heartbeat.ts` + `statusline.ts`.
