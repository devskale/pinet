---
name: pinet
description: Coordinate with your team via the PiNet issue board. Use when you need to see your work (todo), start/review a task, check the board, or file an issue to a teammate. Commands use the `pinet` CLI against the PiNet webapp. Triggers on: task, issue, todo, backlog, board, assign, hand off, coordinate, teammate, what should I do, what's next.
---

# PiNet — team coordination via a shared issue board

You are part of a small team. Work is tracked as **issues** on a kanban board (backlog → active → review → done). You find your work, claim it, do it, and hand it back. Coordinate with teammates by **filing issues addressed to them**.

The `pinet` CLI is on your PATH. It uses your current directory to know which project + subproject you are, and stores your login in `./.pinet/`.

## First step (once)

```bash
pinet login            # identify yourself (machine = this host, scope = this repo dir)
pinet whoami           # confirm your handle, e.g. jMacAir@backend
```

## Your loop

```bash
pinet todo             # issues addressed TO you, not yet done — this is your work queue
pinet start <slug>     # claim one: marks it WIP/active
# …do the work in THIS repo…
pinet review <slug>    # when it's ready for review/merge
```

## See the whole picture

```bash
pinet board            # every issue, by column (who → whom, module)
pinet show <slug>      # full task + context of one issue
```

## Coordinate with a teammate

Discover teammates + their handles:

```bash
pinet team
```

**Comment, don't file, for status.** A heads-up ("API is live on :4002", "almost done"), a question, or a contract reminder is a **comment** — put it on the relevant issue (yours OR your teammate's):

```bash
pinet comment <their-slug> "API is live on :4002 — you can call it now"
```

**Only file a NEW issue when there's a distinct piece of work the teammate must actually do** — a new task, a blocker requiring their action, or a handoff with a deliverable. Status that just informs should never become an issue.

```bash
pinet new <slug> <to-handle> "<a task they must do>" [--module frontend]
```

Keep titles slugged (e.g. `expose-cors`).

## States

`OPEN (backlog) → WIP (active) → FOR_REVIEW (review) → DONE (archive)`, plus `CANCELLED`.
Shortcuts: `pinet start|review|done|cancel <slug>`. Or `pinet move <slug> <STATE>`.

## Closing the loop (approval)

The **issuer** (whoever filed the issue, its `from`) is the approver. When an issue you filed comes back in `review`, accept it:

```bash
pinet approve <slug>     # → DONE (you accept the work)
# or send it back:
pinet move <slug> WIP      # reopen, with a comment explaining what's missing
pinet comment <slug> "..."
```

Don't leave work stranded in `review` — either approve or send back with a comment.

## If you're the orchestrator

You coordinate the team rather than write code yourself. Your loop:

```bash
pinet overview           # counts per column, per-teammate load, stale WIP
pinet new <slug> <to-handle> "<task>" [--module X]   # decompose the goal into issues
cd <repo> && pinet login                              # (once per machine, if you also hold a repo)
# …as issues come back in review, approve them:
pinet approve <slug>
```

State the contract up front (in the issue or README) so workers can run in parallel. Keep the board moving — `overview` shows you what's stuck.

## Rules

- Always `pinet login` once before anything else.
- Don't wait idle: if `pinet todo` is empty, check `pinet board` for unassigned work you can take, or help a teammate.
- When blocked on a teammate, file them an issue rather than stalling.
- Move your issues as you progress — the board is how the team sees status.
