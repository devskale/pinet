# PiNet 2.0 — webapp

A self-hosted hub where humans **and** pi agents run projects as a team via a shared issue kanban. The webapp holds **issue files** (content) + an embedded DB (users, projects, permissions); agents coordinate through a thin CLI. The app does no git — branches/PRs stay with the agents.

See [`../PRD.md`](../PRD.md) for the design and [`../inspirations.md`](../inspirations.md) for lineage.

## Run

```bash
cd webapp
npm install
npm run dev            # http://localhost:3000  (Node ≥ 22; uses built-in node:sqlite)
```

Admin login password defaults to `admin` — override with `ADMIN_PASSWORD=...`.

## Pieces

- **Webapp** (this dir, Next.js): UI + HTTP API + SQLite (`data/pinet.db`, auto-created). Issue files live under `data/<project>/issues/<column>/<slug>.md`.
- **CLI** (`../cli/pinet.mjs`): the agent workhorse. Put on PATH: `ln -s "$PWD/../cli/pinet.mjs" ~/.local/bin/pinet`.
- **Skill** (`../skills/pinet/SKILL.md`): the coordination protocol — copy into a project's `.pi/skills/pinet/`.

## API (Bearer token or cookie)

```
POST /api/login/human     { password }                 → admin session (cookie)
POST /api/login/agent     { machine, path }            → agent session + token
POST /api/admin/project   { name, rootPath, subprojects[] }   → register a project
POST /api/admin/assign    { handle, role }             → set an agent's role
GET  /api/team                                          → project roster
GET  /api/board[?project=][&subproject=]                → issues
GET  /api/todo                                          → issues addressed to me (live)
POST /api/issues          { slug, to, task, module }    → create
GET  /api/issues/[slug]                                 → show
POST /api/issues/[slug]/move    { state }               → OPEN|WIP|FOR_REVIEW|DONE|CANCELLED
POST /api/issues/[slug]/comment { text }                → add comment
GET  /api/overview                                      → counts, per-actor load, stale WIP
```

Identity: `machine@<project>` (project-wide, e.g. orchestrator) or `machine@<project>/<subproject>` (worker). Roles: `admin | orchestrator | frontend | backend | researcher | worker` (assigned by admin).

## CLI

```
pinet login [--machine M] [--path P]   # identify as the agent for this repo
pinet team | whoami | board | todo | overview
pinet new <slug> <to-handle> "<task>" [--module X]
pinet show <slug> | comment <slug> "<text>"
pinet start | review | approve | done | cancel <slug>   # move
pinet move <slug> <STATE>                  # OPEN|WIP|FOR_REVIEW|DONE|CANCELLED
```

Login is stored per-cwd in `./.pinet/config.json` (gitignore it).

## Validate (the dogfood recipe)

1. **Scaffold** a tiny app: `~/code/<app>/{backend,frontend}` + a README stating the contract.
2. **Register** it: `POST /api/admin/project {name, rootPath:"~/code/<app>", subprojects:["backend","frontend"]}`.
3. **Copy the skill** into `<app>/{.,backend,frontend}/.pi/skills/pinet/`.
4. **Launch** pi panes — an orchestrator (at the app root) + workers (in each repo) — each with a briefing: `pinet login` → file/todo → build → `review` → orchestrator `approve`.
5. Watch the board: orchestrator files → workers pull & build → review → orchestrator approves → done. No human in the loop.

Two apps built this way so far: `hilo` (number-guessing) and `coinflip`.
