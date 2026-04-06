# PiNet Roadmap v2 — User-First

Evaluated 2026-04-06. Perspective: a user with multiple machines who wants to spin up a multi-agent project in minutes, not hours.

---

## Current Roadmap Audit

The v1 roadmap is all plumbing. Rightfully so — it got the network built. But from the user's perspective, the remaining items fall into three buckets:

### Cut

| Feature | Why |
|---------|-----|
| Reactions | Zero agent utility. LLMs don't need emoji feedback. |
| Read receipts | Agents don't care if messages were "seen" — they care if work happened. |

### Defer

| Feature | Why |
|---------|-----|
| Threads | Nice-to-have but adds complexity. Sub-teams solve 80% of this. |
| Pinned messages | Useful but low impact vs. the UX wins below. |

### Keep

| Feature | Why |
|---------|-----|
| Network isolation | Multi-project on same relay. Needed for real use. Design complete (`auth.md`). |
| Routing | Mirror + conditional is the foundation for supervision patterns. Design complete (`routing.md`). |
| Mentions | `@agent` forcing delivery in silent mode is genuinely useful. |
| CLI | Terminal access without pi — unlocks scripting and management. |
| Agent daemon | Background agents, no tmux needed. |

---

## The Problem Today

Setting up a 4-agent project requires ~20 manual steps:

```
1.  mkdir frontend backend tester master
2.  mkdir -p frontend/.pi/extensions backend/.pi/extensions ...
3.  ln -s $(pwd)/pinet frontend/.pi/extensions/pinet    (×4)
4.  echo '{"defaultModel":"glm-5.1"}' > frontend/.pi/settings.json  (×4)
5.  echo '{"defaultModel":"claude-sonnet-4"}' > master/.pi/settings.json
6.  Create ~/.pinet/relay.json with tokens
7.  tmux new-session -s project
8.  Split into 4 panes
9.  cd frontend && pi                    (×4)
10. /pinet FrontendDev@build             (×4, different names)
11. Paste scenario into master's pane
```

This is fine for the author. It's a wall for everyone else.

---

## New Proposals

### 1. `pinet init` — Project Templates

**The #1 UX win.** One command to create a fully configured project.

```bash
pinet init fullstack myapp
```

Creates:

```
myapp/
├── .pinet/
│   ├── project.json          # team config, models, roles, machine assignments
│   └── relay.json            # relay connection (created by wizard or manual)
├── frontend/
│   └── .pi/
│       ├── settings.json     # { "defaultModel": "glm-5.1" }
│       └── extensions/pinet → ../../pinet
├── backend/
│   └── .pi/
│       ├── settings.json
│       └── extensions/pinet → ../../pinet
├── master/
│   └── .pi/
│       ├── settings.json     # { "defaultModel": "claude-sonnet-4" }
│       └── extensions/pinet → ../../pinet
└── tester/
    └── .pi/
        ├── settings.json
        └── extensions/pinet → ../../pinet
```

#### Built-in templates

| Template | Agents | Use Case |
|----------|--------|----------|
| `fullstack` | Master, FrontendDev, BackendDev, Tester | General web app |
| `nextjs-devteam` | Architect, UIDev, APIDev, QA | Next.js app (APIDev owns API routes) |
| `devops` | SRE, DeployBot, Monitor | Infra management |
| `code-review` | Author, Reviewer, CI | PR workflow |
| `duo` | Lead, Worker | Pair programming |
| `research` | Researcher, Writer, FactChecker | Document creation |

#### Custom templates

A JSON file in `~/.pinet/templates/`:

```json
{
  "name": "nextjs-devteam",
  "description": "Next.js app with API routes",
  "agents": [
    { "name": "Architect", "model": "claude-sonnet-4", "role": "Plan features, decompose tasks", "dir": "architect" },
    { "name": "UIDev", "model": "glm-5.1", "dir": "frontend" },
    { "name": "APIDev", "model": "glm-5.1", "dir": "backend" },
    { "name": "QA", "model": "glm-4.7", "role": "Validate endpoints + UI", "dir": "qa" }
  ],
  "teams": ["build"],
  "brief": "Build a NextJS app. Architect decomposes tasks. APIDev owns /api/* routes. UIDev owns pages/ and components. QA validates."
}
```

Then: `pinet init nextjs-devteam myapp` → project ready.

#### Template listing

```bash
pinet init --list
# fullstack      General web app (4 agents)
# nextjs-devteam Next.js app with API routes (4 agents)
# devops         Infra management (3 agents)
# code-review    PR workflow (3 agents)
# duo            Pair programming (2 agents)
# research       Document creation (3 agents)
```

#### Effort: ~4hr

---

### 2. `pinet up` / `pinet down` — Start and Stop Projects

Eliminate tmux for the common case.

```bash
pinet up                    # start all agents for this project
pinet up --attach master    # start all, attach to master's terminal
pinet up --machine mac      # start only agents assigned to mac
pinet down                  # send /pinet off to all, kill processes
pinet status                # show all agents: online/offline, machine, uptime
pinet logs master           # tail master's output
pinet restart backend       # restart a single agent
```

`pinet up` reads `.pinet/project.json`, spawns each agent as a child process, and logs them in with the right `name@team`. Output goes to `~/.pinet/projects/<name>/logs/<agent>.log`.

#### Cross-machine

If `project.json` declares agents on multiple machines:

```json
{
  "machines": {
    "mac": ["Master", "FrontendDev"],
    "lubi": ["BackendDev", "Tester"]
  }
}
```

```bash
pinet up                    # start agents for THIS machine only
pinet up --machine all      # SSH to each machine, start its agents
pinet up --machine lubi     # start only lubu's agents (via SSH)
```

#### Effort: ~3hr

---

### 3. Supervisor Agent — Built-in Orchestration

Not a new network primitive. A **special agent role** with extra tools. The supervisor doesn't write code — it coordinates.

```bash
pinet init fullstack myapp --supervisor
```

This adds a `Supervisor` agent with these tools (normal agents don't get them):

| Tool | What |
|------|------|
| `pinet_meeting` | Call a meeting — all agents get `interrupt` with a sync request |
| `pinet_standup` | Ask all agents for status, collect responses, summarize |
| `pinet_escalate` | Promote a digest/silent agent to interrupt for N minutes |
| `pinet_mute` | Temporarily silence an agent (set to silent) |
| `pinet_assign` | Send a tracked task to a specific agent via DM |
| `pinet_progress` | Show what each agent has sent since last meeting |

#### Meeting flow

```
Supervisor: pinet_meeting("build", "Sprint sync — everyone report")
  → All agents in #build get interrupt with "Meeting called: Sprint sync"
  → Each agent responds with status
  → Supervisor collects responses, decides next steps
  → pinet_team_send("build", "Meeting over. New assignments: ...")
```

#### Auto-standup

In `.pinet/project.json`:

```json
{
  "standup": {
    "team": "build",
    "interval": "10min",
    "question": "What did you do? What's next? Any blockers?"
  }
}
```

The supervisor sends the standup question every 10 minutes. Each agent responds. Supervisor summarizes.

#### `pinet_escalate` — importance control

```
Supervisor: pinet_escalate("BackendDev", "5min")
  → BackendDev's delivery mode set to interrupt for 5 minutes
  → After 5min, reverts to previous mode

Supervisor: pinet_mute("Tester")
  → Tester set to silent — won't be interrupted
  → Useful when Tester is running a long validation
```

This is just delivery mode manipulation + scheduling. No new infrastructure — it's a **pattern** built on existing tools plus routing.

#### Effort: ~3hr

---

### 4. `pinet project` — Project Management

Today there's no concept of a "project." Agents exist, teams exist, but no grouping. Add:

```bash
pinet project create myapp --template fullstack
pinet project list                        # show all projects
pinet project status myapp                # agents, teams, machines, uptime
pinet project destroy myapp               # clean up dirs, leave teams
```

`~/.pinet/projects/myapp/project.json`:

```json
{
  "name": "myapp",
  "template": "fullstack",
  "created": "2026-04-06T12:00:00Z",
  "machines": {
    "mac": ["Master", "FrontendDev"],
    "lubi": ["BackendDev", "Tester"]
  },
  "teams": {
    "build": { "token": "a1b2c3..." }
  },
  "agents": {
    "Master": { "model": "claude-sonnet-4", "machine": "mac", "dir": "./master", "role": "coordinator" },
    "FrontendDev": { "model": "glm-5.1", "machine": "mac", "dir": "./frontend" },
    "BackendDev": { "model": "glm-5.1", "machine": "lubi", "dir": "./backend" },
    "Tester": { "model": "glm-4.7", "machine": "lubi", "dir": "./tester", "role": "validation" }
  },
  "brief": "scenarios/todo-app.md"
}
```

One file ties together: which agents, which machines, which teams, which relay tokens, which models.

#### Effort: ~2hr (absorbed into `pinet init`)

---

### 5. `/pinet brief` — Scenario Handoff

Agents need context on startup. Today you paste a scenario into each agent. Tomorrow:

```bash
pinet brief myapp --file scenarios/todo-app.md
```

Sends the scenario to all agents in the project (via team message). Each agent gets the full brief immediately.

Or in `.pinet/project.json`:

```json
{ "brief": "scenarios/todo-app.md" }
```

Agents receive it automatically on `pinet up`. The brief is sent as a team message to each team the agent belongs to.

#### Effort: ~1hr

---

### 6. `pinet deploy` — Cross-Machine Setup

The user has mac + lubu + pi5. Today they SSH to each machine and manually configure. Tomorrow:

```bash
pinet deploy myapp --machine lubi
```

This:
1. SSHes to lubi
2. Creates the project dirs
3. Symlinks the extension
4. Writes `.pi/settings.json` per agent
5. Writes `~/.pinet/relay.json`
6. Starts the agents assigned to that machine

All from the user's laptop. One command per machine.

```bash
pinet deploy myapp --machine all    # deploy to every machine in project.json
```

SSH config must be set up (keys, aliases). Pinet reads machine hostnames from `project.json`.

#### Effort: ~3hr

---

## Revised Roadmap

### Phase 1: Zero-Friction Setup (~8hr)

Get a multi-agent project running in one command.

| Feature | Effort | What |
|---------|--------|------|
| `pinet init` + templates | ~4hr | One command creates fully configured project. Built-in + custom templates. |
| `pinet up` / `pinet down` | ~3hr | Start/stop all agents. No tmux. Logs to file. |
| `/pinet brief` | ~1hr | Auto-deliver scenario to all agents on startup. |

**Deliverable:** `pinet init fullstack myapp && cd myapp && pinet up` → 4 agents running, logged in, briefed.

### Phase 2: Orchestration (~6hr)

Supervision patterns on top of the messaging layer.

| Feature | Effort | What |
|---------|--------|------|
| Supervisor agent tools | ~3hr | `pinet_meeting`, `pinet_standup`, `pinet_escalate`, `pinet_mute`, `pinet_assign`, `pinet_progress`. |
| Routing | ~4hr | Mirror + conditional forwarding. Design complete. Foundation for supervisor patterns. |

**Deliverable:** Supervisor agent auto-coordinates a 4-agent team with meetings and standups.

### Phase 3: Multi-Machine (~9hr)

Seamless cross-machine operation.

| Feature | Effort | What |
|---------|--------|------|
| Network isolation | ~4hr | `~/.pinet/<network>/` namespacing. Design complete. |
| `pinet deploy` | ~3hr | SSH-based cross-machine setup from laptop. |
| `pinet project` management | ~2hr | `project create/list/status/destroy`. Grouping + status. |

**Deliverable:** `pinet init fullstack myapp && pinet deploy --machine all && pinet up --machine all` → 4 agents across 3 machines, running.

### Phase 4: Polish (~4hr)

| Feature | Effort | What |
|---------|--------|------|
| Mentions (`@agent`) | ~1hr | Force delivery even in silent mode. |
| CLI (standalone) | ~2hr | `pinet msg`, `pinet mail` without pi. Scriptable. |
| Agent daemon | ~2hr | Background agents with auto-restart. `pinet daemon start/stop`. |

### Cut

| Feature | Why |
|---------|-----|
| Reactions | No agent utility. |
| Read receipts | No agent utility. |
| Threads | Re-evaluate after Phase 3. Sub-teams cover most cases. |
| Pinned messages | Re-evaluate after Phase 3. |
