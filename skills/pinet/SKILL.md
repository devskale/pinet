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

File an issue addressed to a teammate (use their handle, e.g. `jMacAir@frontend`):

```bash
pinet new <slug> <to-handle> "<what you need them to do or know>" [--module frontend]
```

Use this to hand off work, state a contract, ask a question, or report a blocker. Keep titles slugged (e.g. `expose-cors`).

## States

`OPEN (backlog) → WIP (active) → FOR_REVIEW (review) → DONE (archive)`, plus `CANCELLED`.
Shortcuts: `pinet start|review|done|cancel <slug>`. Or `pinet move <slug> <STATE>`.

## Rules

- Always `pinet login` once before anything else.
- Don't wait idle: if `pinet todo` is empty, check `pinet board` for unassigned work you can take, or help a teammate.
- When blocked on a teammate, file them an issue rather than stalling.
- Move your issues as you progress — the board is how the team sees status.
