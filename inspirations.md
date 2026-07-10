# Inspirations — PiNet 2.0

Three projects we're learning from. Two point at what to be. One points at what *not* to be.

---

## 1. PiNet 1.0 — what *not* to repeat

Agent-to-agent DMs + team chats for pi. Messages written to JSONL files in `~/.pinet/`, a sync daemon bridges the filesystem to a WebSocket relay, which fans out to all machines. Incoming messages are pushed into the agent's conversation via IPC so the LLM acts immediately.

**The good idea:** agents should be able to reach each other and *react* (`pi.sendMessage({ triggerTurn: true })`) without a human copying text between panes. That single capability is what makes them a team.

**What went wrong:** the design front-loaded the hardest, most secondary problem — **cross-machine sync** — and made the whole architecture orbit it. Result: relay server (~800 lines) + sync daemon (~400 lines) + cursors + compaction + presence + rate limiting + wizard + dashboard + templates + a CLI scaffolder to hide it all. ~20 manual steps to start a team, then a templating layer to paper over the 20 steps.

**Lesson for 2.0:** Start with the dead-simple local case. Let cross-machine be an add-on, never the spine. Complexity must be earned by a real, common use case — not a "what if I have 3 machines" hypothetical. *The board/issue coordination model should subsume ad-hoc messaging, not sit beside it.*

---

## 2. Jotnotes (jot) — the model to copy

Mario Zechner's minimal self-hosted collaborative markdown editor. `npm install -g @mariozechner/jot && jot serve`. Open localhost, set a password, done.

**Why it's the model for 2.0:**

- **Built for humans *and* agents, equally.** Same data, two interfaces: a polished web UI for people, and a full CLI/HTTP API for agents. An agent can `jot edit`, `jot comment`, `jot reply` just like a human types in the browser. Neither is an afterthought.
- **Dead simple install.** One npm package, one command, local data dir. No relay, no daemon bridge, no wizard.
- **Access that fits agents.** Owner API keys (full access) *and* share links with configurable levels (view / comment / edit). The link itself is the credential — perfect for handing an agent its scope.
- **Copy-paste agent onboarding.** A "robot icon" generates pre-filled CLI instructions (server URL + note id) you hand straight to your agent.
- **Files on disk.** `.md` + `.json` sidecar in a `data/` dir. The JSON is source of truth; markdown is derived and grep-able. No database ceremony.
- **One thing, done well.** Notes + comments + sharing. No bloat.

**Steal for 2.0:** the dual human/agent interface, the one-command self-hosted install, share-link/API-key access, copy-paste agent onboarding, files-on-disk (no DB), and the discipline of *one job done well*.

### toj — our fork, our conventions

[`devskale/toj`](https://github.com/devskale/toj) (jot, reversed) is our existing fork of jot on the `skalify` branch. It's the proof we've already chosen this form factor — and it pins down the house conventions PiNet 2.0 should match:

- **npm scope:** `@devskale/<name>`
- **CLI binary:** short, distinct name (jot → `toj`)
- **Secrets:** `credgoo` as the preferred key store
- **Flags:** `--insecure` for local/self-signed, validated register URLs
- **Distribution:** npm package, commit `dist/` so `npm i git+https://...` works without a build step
- **Branding:** self-hosted, "forked / inspired by" attribution, skale.dev identity

**Lesson:** ship PiNet 2.0 exactly this way — one `@devskale/` package, a short CLI, credgoo for keys, self-hosted, dead-simple install. Match the bar toj already set.

---

## 3. Paperclip — the ambition to reach for

> "The app people use to manage AI agents for work."

Paperclip reframes agent software: **you run a company, not a tool.** A CEO agent hires a Coder agent; you approve the hire, set the budget, review the strategy, hit go. Open source, self-hosted, `npx paperclipai onboard`.

**Core ideas worth borrowing:**

- **The mental model is a team/org, not a chat.** Roles, reporting lines, job descriptions. "I am managing a team" beats "I am prompting an AI."
- **Goal alignment as a spine.** Mission → project goal → agent goal → task. Every piece of work traces back to *why* it exists, so agents know what to do and why.
- **Work is tickets.** Every conversation traced, every decision explained, full audit log. The ticket/issue is the atom of collaboration — not a chat message.
- **Bring your own agent.** Any provider, any runtime — "if it can receive a heartbeat, it's hired." Model-agnostic, no lock-in.
- **Heartbeats wake agents.** Agents wake on a schedule or on a ticket assignment, check their work, and act. Delegation flows up and down the org.
- **Governance stays human.** You approve hires, override strategy, pause/terminate any agent. Humans are always in charge.
- **Cost control.** Monthly budgets per agent; when they hit the limit, they stop. No runaway spend.

**Take the framing, leave the weight:** PiNet 2.0 isn't trying to be a whole simulated company (org charts, budgets, CEO agents) — at least not at the start. But the *shape* is right: **a project is a small org, work lives on a board of issues, an admin (human or agent) coordinates, and every agent action is visible and auditable.** Paperclip's ticket-as-atom + goal-alignment + heartbeat-wake are the ideas to grow into.

---

## 4. Agent kanban boards — surveying the field

The space already exists. Three stand out; each teaches a distinct lesson.

### graywrk/agent-kanban — pull, don't push

Python (FastAPI + Postgres + React), MIT, self-hosted Docker. The board is a **passive MCP server** — it never spawns or controls agents. You point any MCP-capable agent at it and the agent self-serves via `get_next_task` / `claim_task`.

The big idea: **invert the orchestrator.** Most systems *push* work (a dispatcher decides who does what). agent-kanban makes the board a passive thing agents *pull* from — like a developer grabbing a ticket. This decouples "what needs doing" (board) from "who does it, when" (agent), with zero per-agent glue. Plus hard-assignment (reserve a task for one agent), a live progress feed (agents stream diffs/errors, you comment back, they read it next turn), and inline `git diff base...branch` review.

**Take:** the pull-based model and "board as MCP server, agents self-serve" is the cleanest coordination primitive. An admin can still *hard-assign*, but agents claiming work is the default flow.

### calca/agent-board — issue → branch → PR, on rails

A VS Code Kanban extension (MIT) that turns **GitHub Issues into parallel AI coding sessions**. Auto-squad mode polls for tasks and fills slots (retry/priority/cooldown); each session gets its own **git worktree + branch** (no conflicts, no stashing); a "Create PR" button opens a GitHub PR via `gh`. Live panel streams agent output + changed files. MCP server for full CRUD.

**Take:** the tight loop a board card should have — **task ↔ branch ↔ diff ↔ PR**. This *is* the `gitproject@branch` model: working an issue means working a branch, and the board makes branch/diff/PR first-class.

### BloopAI/vibe-kanban — the polished UX (and a warning)

`npx vibe-kanban`, 10+ agents (Claude Code, Codex, Gemini CLI…), **workspaces** (branch + terminal + dev server + in-app preview), inline diff review with comments sent straight to the agent, AI-written PR descriptions. Beautiful and full-featured.

**But: it's sunsetting.** Great UX reference, cautionary business tale.

**Take:** the "workspace = branch + terminal + preview" framing and diff-review-as-feedback loop set the bar for the agent work surface. And the sunset is a reminder to keep PiNet 2.0 dead-simple and self-hosted so it outlives hype cycles.

### What the field tells us

- **MCP is the agent-facing API standard.** All three expose the board to agents via MCP. Pi (our agent) speaks MCP natively — so an MCP server is the natural way agents read/claim/update issues. A human web UI (and maybe a jot-style CLI) sits alongside.
- **The card ↔ git branch ↔ PR loop is table stakes.** Don't build a board disconnected from git.
- **Pull-based claiming beats push-based dispatch** for self-organizing teams; keep hard-assign for when an admin wants to direct.
- **Nobody owns "simple + self-hosted + git-project-scoped."** vibe-kanban (polished, sunsetting) and agent-board (VS Code-bound) leave a gap. That's the opening PiNet 2.0 aims for.

---

## 5. skale-skills extensions — your own pi-extension patterns

The PiNet 2.0 agent extension isn't built from scratch — it composes patterns you already ship in [`devskale/skale-skills`](https://github.com/devskale/skale-skills)`/extensions/`. Two are directly load-bearing:

### heartbeat.ts — the tick / wake / persist pattern (= "get heartbeat")

A recurring reminder that fires every N seconds, controllable by both human (`/heartbeat` command) and agent (`heartbeat` tool). It's almost exactly the mechanism PiNet's board-polling heartbeat needs:

- **Tick** via `setInterval` / `setTimeout` (`scheduleNext`).
- **Wake the agent** each tick via `pi.sendUserMessage(msg, { deliverAs: "followUp" })` — this is the *current* pi API. (pinet 1.0's older `sendMessage({ triggerTurn: true })` is superseded — correct the PRD's pseudocode to this.)
- **Status line** via `ctx.ui.setStatus()` (countdown bar) — where PiNet would show `📥 2 new`.
- **Persistence** via `pi.appendEntry(...)`, restored on `session_start` / `session_tree` / `session_compact`; stale-ctx safe; timers cleared on `session_shutdown`.
- **Dual control surface:** `pi.registerCommand` (human) + `pi.registerTool` (agent), shared logic.

### statusline.ts — machine identity + footer status

Puts `machineName` first in the footer (resolved via `scutil` on macOS / `hostname`). That's the `machine` half of `machine@scope` **already implemented** — PiNet just appends `@<scope>` and a board badge.

### Conventions to inherit

- Schema'd tools via `typebox` (`Type`, `StringEnum`) + `defineTool`; `ExtensionAPI` from `@earendil-works/pi-coding-agent`.
- Lifecycle hooks: `session_start | session_tree | session_compact | session_shutdown`.
- Background timers `.unref()`'d so they never keep the process alive.
- Targets pi ≥ 0.79.

**Take:** build PiNet's extension *on top of* heartbeat + statusline, not beside them. The board heartbeat = heartbeat's tick / `sendUserMessage` / persist loop, pointed at the file-kanban fingerprint fast-path instead of a fixed message. Identity display = statusline's machine name + `@scope`.

---

## Synthesis — what PiNet 2.0 steals from each

| From | Take |
|------|------|
| **pinet 1.0** | The one good primitive — agents can be triggered to act on new work (`triggerTurn`). And the warning: don't build the spine around cross-machine plumbing. |
| **jotnotes** | The whole *form*: dead-simple self-hosted webapp, dual human/agent access (web + CLI/API), share-link scoping, copy-paste agent onboarding, files-on-disk, one job done well. |
| **paperclip** | The *mental model*: a project is a team/org, work = issues/tickets on a board, goal alignment, an admin coordinates, heartbeats wake agents, humans govern. |
| **agent-kanban field** | The *coordination mechanics*: pull-based task claiming, the card↔branch↔diff↔PR git loop, and (rejected for us) board-as-MCP — we use a pi extension/skill instead. |
| **skale-skills extensions** | The *implementation patterns*: heartbeat tick → `sendUserMessage({deliverAs:"followUp"})` → persist, machine-name identity, `registerCommand`+`registerTool` dual surface, lifecycle hooks. Build on these, don't reinvent. |

**The shape of 2.0 in one line:** *jotnotes' simplicity and dual-interface, applied to paperclip's project-as-a-team ticket model on top of kontext.one's proven file-kanban — a pure-state board (no git in the app), agents pull work via a pi extension/skill (no MCP) and self-wake on a heartbeat fingerprint, and an admin (human or agent) coordinates.*
