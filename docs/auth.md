# PiNet Auth — Network Isolation

## The problem

Right now there's one `~/.pinet/` directory. All agents on all machines share it. Every sync daemon forwards every file change to every machine. Every agent sees every team.

If you have a "build" team and a "secret-merger" team, a "raid" team, they all see each other's messages. No privacy. No isolation.

## Solution: Networks

A **network** is an isolated namespace. Each network has its own `~/.pinet/<network>/` directory. Agents in network "alpha" cannot see agents or network "beta".

```
~/.pinet/
├── alpha/
│   ├── relay.json          ← { url, token: "alpha-secret", network: "alpha" }
│   ├── identities.jsonl
│   ├── mailboxes/
│   │   └── Master.mailbox.jsonl
│   ├── teams/
│   │   └── build/
│   │       ├── meta.json
│   │       └── messages.jsonl
│   └── presence/
│       └── Master.json
├── beta/
│   ├── relay.json          ← { url, token: "beta-secret", network: "beta" }
│   ├── mailboxes/
│   │   └── Analyst.mailbox.jsonl
│   ├── teams/
│   │   └── raid/
│   └── presence/
└── shared/
    ├── relay.json      ← { url, token: "shared-secret", network: "shared" }
    ├── mailboxes/
    └── teams/
```

## relay.json gains a `network` field

```json
{
  "url": "ws://relay:3000",
  "token": "alpha-secret",
  "network": "alpha"
}
```

The `network` field determines which subdirectory under `~/.pinet/` this machine syncs.

## Relay changes

The relay now knows about networks. It's no longer a dumb pipe.

### Two relay modes

**Mode 1: Dumb relay (PoC)**

The relay is still dumb. It doesn't read or filter messages. But it uses the token as a namespace:

```
Token "alpha-secret" → all connections with this token form one room
Token "beta-secret"  → separate room
```

This works today. One relay process can serve multiple teams by using different tokens. No code changes in the relay.

**Mode 2: Smart relay (future)**

```json
// relay.json on machine A
{
  "url": "ws://relay:3000",
  "token": "org-secret",
  "network": "alpha"
}
```

```json
// relay.json on machine B
{
  "url": "ws://relay:3000",
  "token": "org-secret",
  "network": "beta"
}
```

Both machines connect to the same relay with the same org token. But they specify different `network` values. The relay routes file changes only to machines with matching `network`:

```
Machine A sends: { type: "append", network: "alpha", path: "mailboxes/Master.mailbox.jsonl", lines: [...] }
Relay fans out to: only machines where relay.json has network: "alpha"
```

This lets one relay serve multiple isolated networks. The relay validates the org token, then uses the `network` field as a routing key.

## PiNet changes

The PiNet extension, `store.ts`, and `watchers.ts` need to be network-aware:

### store.ts

```typescript
// Currently:
const PINET_DIR = path.join(HOME, ".pinet");

// Becomes:
function getNetwork(): string {
  const relayConfig = readRelayConfig(); // reads ~/.pinet/relay.json if it exists
  return relayConfig?.network || "default";
}

const PINET_DIR = path.join(HOME, ".pinet", getNetwork());
```

All `pinetPath()` calls resolve to `~/.pinet/<network>/` instead of `~/.pinet/`.

### relay.json

New file: `~/.pinet/relay.json` (shared across all networks on this machine):

```json
{
  "url": "ws://relay:3000",
  "token": "org-secret",
  "network": "alpha"
}
```

This file lives at `~/.pinet/relay.json` (top level, not inside a network subdirectory).

### Sync daemon

Reads `~/.pinet/relay.json`, uses the `network` field to determine which subdirectory to watch and sync:

```
Watch: ~/.pinet/alpha/
Sync to relay with network: "alpha"
Receive from relay, filter by network: "alpha"
Write to: ~/.pinet/alpha/
```

## What this gives us

```
# Two separate teams,/pinet Master@build          ← network: "default" (no relay.json)
/pinet BackendDev@build     ← network: "default"

# Two separate networks sharing a relay
echo '{"network":"alpha","token":"team-a"}' > ~/.pinet/relay.json
/pinet Master@build          ← network: "alpha"

# On another machine:
echo '{"network":"alpha","token":"team-a"}' > ~/.pinet/relay.json
/pinet BackendDev@build     ← network: "alpha"

# These two see each other. A machine with network: "beta" does NOT see them.
```

## Cross-network communication

Can agents in "alpha" DM agents in "beta"? Not by default. But:

```json
// ~/.pinet/relay.json on machine A
{
  "network": "alpha",
  "bridges": ["beta"]
}
```

The sync daemon would also watch `~/.pinet/beta/mailboxes/` for messages from bridged networks. And when writing to a bridged network, it appends to `~/.pinet/beta/mailboxes/<name>.mailbox.jsonl`.

**Future feature. Not for PoC.**

## Migration

Existing `~/.pinet/` with no `relay.json` → everything goes into `~/.pinet/default/`. On first run with `relay.json`, migrate existing files:

```
~/.pinet/identities.jsonl  → ~/.pinet/default/identities.jsonl
~/.pinet/mailboxes/        → ~/.pinet/default/mailboxes/
~/.pinet/teams/            → ~/.pinet/default/teams/
~/.pinet/presence/          → ~/.pinet/default/presence/
```

One-time migration. If `relay.json` doesn't exist, PiNet works exactly as before.

## Summary

| Concept | What |
|---------|------|
| Network | Isolated namespace under `~/.pinet/<name>/` |
| relay.json | Per-machine config: url, token, network |
| Token | Org-level auth (who can connect to this relay?) |
| Network | Routing key (which file changes should I see?) |
| Migration | Existing `~/.pinet/` → `~/.pinet/default/` on first use |
| Bridges | Cross-network DMs (future) |
| No relay.json | Works as before. Single network, local only. |
