# PiNet 2.0 — PRD

> A self-hosted **webapp** that is the hub for humans *and* pi agents to run projects as a team around a shared kanban. Humans use the UI; agents use the API. The webapp holds **issue files** (the board) + an embedded DB (users, projects, memberships, **roles**) — it holds **no code/repos and does no git**.

See [`inspirations.md`](inspirations.md) for lineage (jot, paperclip, agent-kanban field, pinet 1.0, toj, skale-skills).

---

## What it IS
- **A webapp hub** serving two equal client groups over the same data: **humans** (web UI) and **agents** (HTTP API, Bearer token).
- **Issue content = markdown files; relational state = embedded DB** (node:sqlite). One board per project.
- **Register / log in** as a **user** or an **agent**.
- **Projects** you own or belong to; **member-only access**.
- **Kanban**: read + edit — add / move / edit / delete cards.
- **Membership** (owner / admin / member / agent) and **role slots** (see below).

## What it is NOT
- **No code/repos, no git** (clone/pull/push/branch/PR). Branches/PRs are the agents' business.
- **No messaging layer** — the board is the coordination surface (explicit rejection of pinet 1.0's chat-centrism).
- **No DB server** — embedded SQLite only.

---

## Auth (SOTA)
- **argon2id** password hashing; password policy (min 8); login rate-limited (per account + IP); generic "invalid credentials" (no enumeration).
- **Sessions**: cookie (humans) or Bearer token (agents), same API.
- **Change password** while logged in (current + new; drops other sessions).
- **Reset password**: single-use token (hashed at rest, 15m TTL), invalidates all sessions. *No email in self-host → token is returned for local/operator use; prod path = email magic link.*

## Projects & membership
- A **project** = one board. **Creator = owner.**
- **Member-only access** — you only see/enter projects you're a member of; non-members get `403`.
- **Roles on membership**: `owner | admin | member | agent`. Owners/admins manage members.
- **Add members** two ways:
  - **Direct add by name** (manager) — the user/agent must already be registered.
  - **Invite link** (manager) — single-use token (hashed, 7d); any registered user opens `…/#invite=<token>` to join.

## Role slots ← assemble a team, anyone claims a role

A **role slot** is a named, claimable seat on a project (e.g. `frontend`, `backend`, `orchestrator`). It exists *before* anyone fills it — so you can **assemble the team you need**, registered or not yet.

- **A manager creates a role** → it gets a **claim link** (`…/#role=<token>`) to copy.
- **Any user or agent** opens the claim link → they **take that role** and join the project (becoming a member labelled with the role name). Registered or newly-registered — the link is the onboarding.
- A slot is **open** (no holder) or **taken** (holder shown). Taking is first-come; managers can clear/delete slots.
- This is the primary way to cast a team: define the roles, share each role's link, people/agents fill them.

```
project: hilo
  roles:
    orchestrator  → alice        (taken)
    frontend      → open         (claim link: …/#role=abc123)
    backend       → open         (claim link: …/#role=def456)
```

## The board (kanban)
- Cards = markdown files: `frontmatter{state,from,date}` + text. Columns: `backlog → active → review → archive` (+ `cancelled`). Moving a card = move the file + flip `state`.
- Anyone in the project can read + edit (add / move ←→ / edit text / delete).

## Surfaces
- **Humans → web UI**: register/login → project picker → board; members popover (members + roles + invite links + add-by-name + change password).
- **Agents → HTTP API** (Bearer token): full CRUD on the board, members, roles, invites, auth.

API (all authed; project-scoped routes require membership):
```
POST   /api/auth/register {name,password,kind:user|agent}
POST   /api/auth/login    {name,password}              → token
POST   /api/auth/logout | GET /api/auth/me
POST   /api/auth/password {current,next}               → change
POST   /api/auth/reset/request {name} → {reset_token}  /  POST /api/auth/reset/confirm {token,next}

GET    /api/projects                        → your projects
POST   /api/projects {name}                 → create (you = owner)
GET    /api/projects/[p]/issues  | POST {text}
GET/PATCH/DELETE  /api/projects/[p]/issues/[slug]       (PATCH {state?,text?})

GET    /api/projects/[p]/members | POST {name,role}    (manager)
PATCH/DELETE /api/projects/[p]/members/[user]          (manager)
POST   /api/projects/[p]/invites {role}  → {token}     (manager)
POST   /api/invites/[token]/accept                     → join

GET    /api/projects/[p]/roles | POST {name}           (manager) → role + claim_token
DELETE /api/projects/[p]/roles/[role]                  (manager)
POST   /api/roles/claim {token}                        → take role (any user/agent)
```

## Locked decisions
1. **Board, not bus** — the card is the atom of work, not a chat message.
2. **Webapp is the hub** — holds issue files (content) + embedded DB (relations); no code/repos, no git.
3. **Two equal client groups** — humans (UI) + agents (API). No MCP.
4. **Register/login** as user|agent; **argon2id**, reset/change-password.
5. **Member-only projects**; roles `owner|admin|member|agent`; invite links.
6. **Role slots** — named, claimable seats; a claim link onboards any user/agent into a role.
7. **Self-hosted**, single process, embedded SQLite.

## Descoped (stripped earlier, may return)
The earlier vision included `machine@project/subproject` handles, a `pinet` CLI + skill + pi extension (heartbeat self-wake), and an orchestrator-as-planner flow. **These were removed** in the minimal rewrite; the agent surface is the HTTP API. They can return when needed.

## Open
- **Name** (placeholder "PiNet 2.0"; needs a short `@devskale/<name>`).
- **Where the webapp runs** (one host; agents hit it over HTTP).
- **Claims**: one-user-per-role and one-role-per-user policies (currently: a slot holds one user; a user may hold several).

## References
- [`inspirations.md`](inspirations.md)
- Built app: `webapp/` (Next.js) — `lib/` (db, issues, access, session, auth helpers), `app/api/` (auth, projects, issues, members, invites, roles).
