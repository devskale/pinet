# Todo App — Shared Goal

Build a full-stack todo application split across two projects.

## Backend (in ../backend/)

Build a REST API using Node.js + Express (no DB, in-memory store).

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

## Frontend (in ../frontend/)

Build a single-page app using vanilla HTML + CSS + JS (no framework).

Requirements:
- Show list of todos
- Add new todo (input + button)
- Toggle done/undone (checkbox)
- Delete todo (button)
- Fetch from `http://localhost:3000/todos`

## Coordination

- Backend dev: design and build the API first, then tell FrontendDev it's ready
- Frontend dev: wait for BackendDev's API confirmation, then build against it
- Both: read this file, use PiNet to communicate (pinet_send / pinet_mail)
