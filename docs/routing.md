# PiNet Routing — Mirror & Conditional

## What

Two routing primitives that automatically copy or forward messages based on rules. Agents don't need to remember to CC — the network handles it.

## File layout

```
~/.pinet/
├── routes/
│   └── <name>.json          # route definitions
```

Each route is a JSON file. Routes are picked up by all running agents.

## Mirror

Copy every message from a source to a destination.

```json
{
  "name": "build-audit",
  "type": "mirror",
  "source": "team:build",
  "destination": "team:audit-log",
  "enabled": true
}
```

### Mirror sources

| Source | Matches |
|--------|---------|
| `team:<name>` | All messages in a team |
| `agent:<name>` | All DMs sent to an agent (personal mailbox writes) |

### Mirror destinations

| Destination | Delivers to |
|-------------|------------|
| `team:<name>` | Appends to team's messages.jsonl |
| `agent:<name>` | Appends to agent's personal mailbox |

### How it works

After a message is written (by `pinet_send` or `pinet_team_send`), the agent checks all mirror routes where the source matches. If matched, the message is copied to the destination with an additional field:

```json
{
  "id": "uuid",
  "from": "BackendDev",
  "team": "build",
  "body": "API deployed!",
  "timestamp": "...",
  "mirroredFrom": "team:build"
}
```

The receiving agent sees it as a normal message — no special handling needed.

### Examples

```json
// Mirror all build team messages to an audit log team
{ "name": "build-audit", "type": "mirror", "source": "team:build", "destination": "team:audit-log" }

// Mirror all DMs to Master into the oversight team
{ "name": "master-oversight", "type": "mirror", "source": "agent:Master", "destination": "team:oversight" }
```

## Conditional

Forward a message only if it matches a condition.

```json
{
  "name": "error-escalation",
  "type": "conditional",
  "source": "team:build",
  "conditions": [
    { "field": "body", "operator": "contains", "value": "error" }
  ],
  "destination": "agent:Tester",
  "enabled": true
}
```

### Condition operators

| Operator | What |
|----------|------|
| `contains` | Body contains the value (case-insensitive) |
| `starts_with` | Body starts with value |
| `regex` | Body matches regex pattern |
| `from` | Message from a specific agent |

### Multiple conditions

Conditions are OR by default. Add `"mode": "and"` for AND:

```json
{
  "conditions": [
    { "field": "body", "operator": "contains", "value": "blocked" },
    { "field": "from", "operator": "equals", "value": "BackendDev" }
  ],
  "mode": "and"
}
```

### Examples

```json
// Escalate errors to Tester
{ "name": "error-escalation", "type": "conditional", "source": "team:build",
  "conditions": [{ "field": "body", "operator": "contains", "value": "error" }],
  "destination": "agent:Tester" }

// Notify ops team on deploy mentions
{ "name": "deploy-notify", "type": "conditional", "source": "team:build",
  "conditions": [{ "field": "body", "operator": "contains", "value": "deploy" }],
  "destination": "team:ops" }

// Escalate when BackendDev says they're blocked
{ "name": "blocked-escalation", "type": "conditional", "source": "team:build",
  "conditions": [
    { "field": "from", "operator": "equals", "value": "BackendDev" },
    { "field": "body", "operator": "contains", "value": "blocked" }
  ],
  "mode": "and",
  "destination": "agent:Master" }
```

## Tools

| Tool | What |
|------|------|
| `pinet_route_add` | Create a mirror or conditional route |
| `pinet_route_remove` | Delete a route |
| `pinet_route_list` | List all active routes |

`pinet_route_add` takes the full route definition as a parameter. No CLI needed — agents set up their own routes.

## Implementation

Routes are checked **after** the message is written, by the sending agent:

1. Agent calls `pinet_send` or `pinet_team_send`
2. Message gets written to the target file (existing behavior)
3. Agent reads all route files from `~/.pinet/routes/`
4. For each route where source matches:
   - Mirror: copy message to destination
   - Conditional: check conditions, if matched copy to destination
5. Destination sync daemons deliver naturally — no special delivery needed

This means routes are evaluated by the sender, not the receiver. Keeps it simple — no background process needed.

## Route file

```json
// ~/.pinet/routes/error-escalation.json
{
  "name": "error-escalation",
  "type": "conditional",
  "source": "team:build",
  "conditions": [
    { "field": "body", "operator": "contains", "value": "error" }
  ],
  "destination": "agent:Tester",
  "enabled": true,
  "createdBy": "Master",
  "createdAt": "2026-04-03T20:00:00.000Z"
}
```

## Preventing loops

- Mirror cannot mirror to its own source (rejected on creation)
- A message that arrives via routing (has `mirroredFrom` field) is not re-routed
- Max routing depth: 1 hop (no chain of mirrors)

## Validation test

```
4 agents in team "build": Master, BackendDev, FrontendDev, Tester

1. Master creates route: mirror team:build → team:audit-log
2. Master creates route: conditional team:build contains "error" → agent:Tester
3. BackendDev sends: "Build complete, API running"
   → mirrored to #audit-log
   → no conditional match
4. FrontendDev sends: "Getting CORS error from API"
   → mirrored to #audit-log
   → conditional matches → forwarded to Tester
5. Tester receives the forwarded message, investigates
```
