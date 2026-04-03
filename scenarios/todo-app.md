# Todo App — Shared Goal

Build a full-stack todo application. Three agents collaborate: one oversees, two build.

## Roles

### Master (overseer)

Does not write code. Reads this spec, assigns tasks, monitors progress, reviews work.

Responsibilities:
- Read the full spec and understand the architecture
- Tell BackendDev to start building the API
- Tell FrontendDev to stand by until the API is ready
- Review BackendDev's and FrontendDev's code by reading their files
- Resolve blockers and answer questions
- Declare the project done when everything works

### BackendDev

Builds the REST API in `../backend/` using Node.js + Express (no DB, in-memory store).

Endpoints:
- `GET /todos` — list all todos
- `POST /todos` — create a todo `{ title: string }` → returns `{ id, title, done, createdAt }`
- `PATCH /todos/:id` — update a todo `{ title?, done? }`
- `DELETE /todos/:id` — delete a todo

Rules:
- Port 3000
- JSON responses
- CORS enabled (for frontend dev server)
- Start with 2 seed todos
- Report to Master when the API is running
- Answer FrontendDev's questions about the API directly

### FrontendDev

Builds a single-page app in `../frontend/` using vanilla HTML + CSS + JS (no framework).

Requirements:
- Show list of todos
- Add new todo (input + button)
- Toggle done/undone (checkbox)
- Delete todo (button)
- Fetch from `http://localhost:3000/todos`
- Wait for Master (or BackendDev) to confirm the API is ready before starting
- Ask BackendDev directly if the API contract is unclear
- Report to Master when the UI is done

## Coordination

- **Master → BackendDev**: assign backend task, review code, approve
- **Master → FrontendDev**: tell when to start, review code, approve
- **BackendDev → Master**: report API ready, report issues
- **FrontendDev → Master**: report UI done, report issues
- **FrontendDev ↔ BackendDev**: clarify API details directly (no need to go through Master)
- All agents use PiNet tools: `pinet_send`, `pinet_mail`, `pinet_list`
