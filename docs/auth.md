# PiNet Auth — Cross-Machine Identity

## The problem

On one machine, identity is simple: `/pinet Master` checks if another live process (same PID namespace) already claimed "Master". If yes, rejected. PID check works.

Across machines, PID namespaces are independent. Machine A's PID 1234 ≠ machine B's PID 1234. The current presence check breaks:

```
Machine A: Master logs in → presence/Master.json = { pid: 1234 }
Sync daemon copies to Machine B
Machine B: someone tries /pinet Master
  → reads presence/Master.json, sees pid: 1234
  → process.kill(1234, 0) → might hit an unrelated process on machine B!
  → or returns false → lets them impersonate Master
```

**This is a bug.** The presence check doesn't work across machines.

## Solution: machine-scoped presence

Presence entry gains a `machine` field:

```json
{
  "name": "Master",
  "status": "online",
  "pid": 1234,
  "machine": "johann-mac",
  "lastSeen": "..."
}
```

Login checks:
```
Is "Master" already online?
  → Read presence/Master.json
  → If machine === "johann-mac" AND pid is alive (local check) → reject
  → If machine !== local machine → the agent is on a different machine
      → Trust it. That's a different Master. But wait — we want unique names across the network.
```

**A name must be unique across the entire network, not just one machine.**

New login check:

```
1. Read presence/Master.json (synced from all machines)
2. If it exists:
   a. If machine === my machine AND pid alive → "already logged in here"
   b. If machine !== my machine AND status === "online" → "name taken on <machine>"
   c. If pid dead or status "offline" → name is free, claim it
3. Write my presence with my machine ID
```

## Auth layers

Three separate concerns:

### Layer 1: Machine auth (relay level)

Who can connect to the relay at all?

**PoC**: shared token in `relay.json`. One token per network. All machines use the same token.

```
relay.json: { "token": "my-secret" }
Relay: rejects connections with wrong token
```

This is like a WiFi password. Everyone in the network knows it. Anyone with it can connect and see all traffic.

**Future**: per-machine tokens issued by relay admin. Revocable. But for PoC, shared secret is fine.

### Layer 2: Agent identity (PiNet level)

Who can claim the name "Master"?

**PoC**: first-come, first-served. The name goes to whoever logs in first. Presence file (now machine-scoped) enforces uniqueness.

No passwords for agents. The identity is claimed, not proven. If you're on the network (passed Layer 1), you can claim any unclaimed name.

**Impersonation risk**: if Alice disconnects and Bob quickly does `/pinet Alice`, he gets the name. Messages meant for Alice go to Bob.

**Mitigation**: identity claim requires the same machine. Once "Master" is bound to machine "johann-mac", only johann-mac can reclaim it. Store in identity:

```json
// presence/Master.json
{
  "name": "Master",
  "machine": "johann-mac",
  "bound": true
}
```

Login rule: if `bound === true` and requesting machine !== bound machine → reject. Name is locked to that machine.

Unbinding: `/pinet off` sets `bound: false`, or a timeout (24h) auto-unbinds.

### Layer 3: Team membership (PiNet level)

Who can join team "build"?

**PoC**: anyone on the network. `name@build` auto-joins. Trust is social.

**Future**: team creator can set a policy:

| Policy | Meaning |
|--------|---------|
| `open` | Anyone can join (default) |
| `invite` | Only invited agents can join |
| `request` | Anyone can request, creator approves |

For PoC: all teams are `open`. If you're on the network, you can join any team.

## The practical threat model

| Threat | PoC | Future |
|--------|-----|--------|
| Stranger connects to relay | Shared token prevents | Per-machine tokens |
| Agent impersonates another agent | Machine binding prevents | Per-agent signing keys |
| Agent joins team without permission | Allowed (open teams) | Invite/request policies |
| Machine goes rogue, floods relay | Rate limit per connection | Token revocation |
| MITM on relay connection | Not prevented | TLS (wss://) |
| Relay operator reads messages | They can — don't run relay you don't trust | End-to-end encryption |

For PoC: shared token + machine-bound identities + open teams. This is enough.

## Updated presence format

```json
// ~/.pinet/presence/Master.json
{
  "name": "Master",
  "status": "online",
  "pid": 1234,
  "machine": "johann-mac",
  "lastSeen": "2026-04-03T20:00:00.000Z"
}
```

New field: `machine`. Set from `relay.json`'s `machine` field, or hostname if no relay.

## Updated login flow

```
/pinet Master@build

1. Read presence/Master.json
2. If exists:
   a. status "online", same machine, pid alive → reject "already logged in"
   b. status "online", different machine → reject "Master is online on <machine>"
   c. status "offline" or pid dead → name is free
3. Write presence/Master.json with { machine: myMachineId }
4. Continue as before (identity, mailbox watcher, team join)
```

`myMachineId` comes from:
- `relay.json`'s `machine` field if present
- `os.hostname()` if no relay (local-only mode)

## What changes in PiNet code

1. `store.ts`: `writePresence()` adds `machine` field
2. `store.ts`: `readAllPresence()` no longer filters by PID alone — also checks machine
3. `index.ts`: `doLogin()` checks machine-scoped presence before claiming name
4. No changes to relay (relay doesn't know about any of this)

## What changes in sync daemon

1. Sync daemon reads `relay.json` to get `machine` ID
2. Passes machine ID to PiNet somehow (env var? config file?)
3. Or: PiNet reads machine ID from `~/.pinet/machine.json` (written by sync daemon or manually)

Simplest: PiNet reads machine ID from `~/.pinet/machine.json`. Sync daemon creates it on start. If no file, machine = hostname.

```json
// ~/.pinet/machine.json
{ "machine": "johann-mac" }
```
