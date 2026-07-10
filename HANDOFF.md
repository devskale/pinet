# PiNet 2.0 — Handoff / Status

**Branch:** `2.0` · **Date:** 2026-07-10 · **Server:** `npm run dev` in `webapp/` (port 3000)

---

## What PiNet 2.0 is

A self-hosted webapp where humans (UI) and pi agents (API) run projects as a team around a shared kanban board. No git, no code repos — just issue files + an embedded DB. See [`PRD.md`](PRD.md).

## What works (backend, all verified)

- **Auth:** register/login as `user` or `agent`; argon2id hashing; password change; password reset (token flow); rate-limited login. Cookie (humans) + Bearer token (agents).
- **Projects:** create (creator = owner role); list (member-only); pick.
- **Kanban board:** add / move ←→ / edit / delete cards. Markdown files, columns backlog→active→review→archive.
- **Role slots (NEW):** named, claimable seats. Create a role → copy its `#role=<token>` link → any user/agent opens it to take that role and join the project. Manager can fill-by-name, unassign, delete.
- **Membership is derived from role holdings:** a user is a member iff they hold a role slot. Owner holds the "owner" slot. Managers = owner/admin role holders.
- **Members UI (popover):** clean row-based design; `⋯` menu for copy-instructions/remove; invite links; create-role; copy-claim-link.

## What's incomplete (resume here)

### 1. Members UI → role-centric team view (IN PROGRESS)
The backend is done (role slots, fill, claim, clear, derive). The **UI Members component still shows the old members-list + add-by-name** layout. It needs rewriting to a **role-centric team view**:
- Show roles (slots) as the team: each role = name + holder (or "open").
- Open slots: "copy link" (claim) + manager "assign by name" input.
- Held slots: holder name + manager "unassign" button.
- Create role: input + +.
- The owner shows as "owner" role held by the creator.

**Backend endpoints ready:** `GET/POST /api/projects/[p]/roles`, `POST /roles/[role]/fill`, `PATCH/roles/[role]` (clear holder), `DELETE /roles/[role]`, `POST /api/roles/claim`.

### 2. DB reset needed
The membership model changed (derived from roles, not project_members). **Old DB data is incompatible.** On resume:
```bash
cd webapp && rm -rf data && npm run dev   # fresh DB, auto-creates schema
```

### 3. Obsolete routes still present (harmless but should be cleaned)
- `app/api/projects/[project]/members/route.ts` — uses old addMember; superseded by roles fill.
- `app/api/projects/[project]/invites/` + `app/api/invites/` — general invite system; superseded by role claim links.
- Can be removed once the UI no longer references them.

### 4. PRD updated but stale sections
PRD was rewritten to match the current app. The "Descoped" section notes what was stripped (CLI, extension, heartbeat, orchestrator).

---

## How to resume

```bash
cd /Users/johannwaldherr/code/agents/pis/dev/pinet
git checkout 2.0
cd webapp && rm -rf data .next && npm run dev   # fresh start
```

Then register a user, create a project, create roles, and wire up the UI team view.

## Key files

| File | What |
|------|------|
| `PRD.md` | Product spec (updated) |
| `inspirations.md` | Lineage + research |
| `webapp/lib/db.ts` | DB schema + queries (users, projects, roles, issues, sessions, invites, resets) |
| `webapp/lib/access.ts` | ctxFor (membership check) + isManager |
| `webapp/lib/issues.ts` | Issue file store (frontmatter + columns) |
| `webapp/app/page.tsx` | The entire UI (auth, projects, board, members popover) |
| `webapp/app/api/` | All routes (auth, projects, issues, roles, claim, members, invites) |

## Registered users/agents (will be lost on DB reset)

| Name | Kind | Password |
|------|------|----------|
| skale | user | skale-2026 |
| johann | user | johann-2026 |
| frontend | agent | frontend-2026 |
| backend | agent | backend-2026 |
| orchestrator | agent | orch-2026 |
| test@test | user | testtest |
