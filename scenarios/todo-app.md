# Todo App — Team Scenario

Build a full-stack todo application. Four agents in team "build".

## Setup

```bash
# Prepare workspaces
for dir in frontend backend tester mastermaster; do
  mkdir -p $dir/.pi/extensions
  ln -s $(pwd)/pinet $dir/.pi/extensions/pinet
done

# Start 4 tmux panes, each: cd <dir> && pi
# Then in each: /pinet <Name>@build
```

## Roles

### Master (`/pinet Master@build`)

Does not write code. Coordinates the team.

- Read this spec
- Use `pinet_team_send` to assign tasks to the team
- Use `pinet_send` for 1:1 conversations
- Monitor progress, resolve blockers
- Declare done when everything works

### BackendDev (`/pinet BackendDev@build`)

Build the REST API in `./backend/` using Node.js + Express.

Endpoints:
- `GET /todos` — list all todos
- `POST /todos` — create `{ title }` → `{ id, title, done, createdAt }`
- `PATCH /todos/:id` — update `{ title?, done? }`
- `DELETE /todos/:id` — delete

Rules: Port 3000, JSON, CORS enabled, 2 seed todos.

### FrontendDev (`/pinet FrontendDev@build`)

Build a single-page app in `./frontend/` using vanilla HTML + CSS + JS.

Requirements: Show todos, add, toggle done, delete. Fetch from `http://localhost:3000/todos`.

Wait for confirmation that the API is ready before starting.

### Tester (`/pinet Tester@build`)

After both API and frontend are done:
- Validate API endpoints with curl
- Test the frontend loads and connects
- Report results to the team

## Coordination

Use team chat (`pinet_team_send`) for announcements and status updates.
Use personal DMs (`pinet_send`) for 1:1 questions.

Expected flow:
1. Master: "BackendDev: build the API. FrontendDev: stand by. Tester: stand by."
2. BackendDev: "API live on :3000."
3. Master: "FrontendDev: go."
4. FrontendDev: "Frontend done."
5. Tester: "API passes. Frontend works. Done ✅"
6. Master: "Ship it."
