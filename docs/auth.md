# PiNet Auth — Deep Dive

## The real scenario

```
Machine A (MacBook)     Relay (cloud VM)     Machine B (desktop)
─────────────────     ──────────────────     ─────────────────
pi session 1                                    pi session 3
  FrontendDev                                     BackendDev
pi session 2                                    pi session 4
  Master                                          Tester
```

Multiple pi sessions per machine. Each running PiNet. All connected through one relay. Need to discover each other, collaborate.

## Why shared-secret is insufficient

| Problem | Example |
|---------|---------|
| Token leak = full access | Anyone with the token connects and sees ALL file changes for ALL agents |
| No revocation | Compromised machine? Change token everywhere. |
| No machine identity | Relay can't tell machines apart. Any connection with the token is trusted. |
| No audit trail | Can't tell who sent what. A rogue machine could inject fake messages. |

But for PoC (2-4 machines, trusted humans), shared-secret is actually fine. Let's be honest about what level of security is needed when.

## Auth levels — what threat model demands

| Scale | Threat | Auth needed |
|-------|--------|-------------|
| 1-2 machines, yourself | None. Shared secret is overkill. |
| 3-10 machines, small team | Shared secret is fine. Trust your teammates. |
| 10+ machines, org | Per-machine keys. Ability to revoke. |
| Open/public relay | Full PKI. Signed messages. Per-agent tokens. |

**For PoC: shared-secret is correct. Ship it.**

But let's design the upgrade path so the architecture doesn't need to change later.

## Proposed: tiered auth

### Tier 1: Shared secret (PoC — ship this)

```json
// ~/.pinet/relay.json
{
  "url": "ws://relay.example.com:3000",
  "token": "our-team-secret"
}
```

One token. All machines use it. Relay validates on connect. Done.

**Upgrade path:** the `relay.json` format doesn't change. The relay's validation just gets stricter.

### Tier 2: Per-machine keys (multi-team)

Each machine generates a keypair. The relay admin registers the public keys.

```
~/.pinet/relay.json
{
  "url": "ws://relay.example.com:3000",
  "machine": "johann-mac",
  "privateKey": "-----BEGIN PRIVATE KEY-----\n..."
}

~/.pinet/relay.json
{
  "url": "ws://relay.example.com:3000",
  "machine": "cloud-vm",
  "privateKey": "-----BEGIN PRIVATE KEY-----\n..."
}
```

Auth flow:
```
Machine connects to relay
  → Sends: { type: "auth", machine: "johann-mac", signature: <sign(timestamp+machine+token) with private key> }
  → Relay has stored public keys (registered by admin)
  → Relay verifies signature
  → Relay sends { type: "welcome", machines: [...] }
```

Benefits:
- Each machine has unique identity
- Relay can reject individual machines without affecting others
- Signature proves machine identity (can't forge without private key)
- Admin can revoke by removing public key from relay config

**No relay restart needed** to revoke — just remove the public key from relay's config and the next reconnect attempt fails.

### Tier 3: Relay-administered tokens (future)

For public relays or large orgs:

```
# Admin generates an invite token
pinet-admin invite --machine johann-mac --team build
  → Outputs: pinet_mac_johann_abc123

# User configures
echo '{"url":"...","token":"pinet_mac_johann_abc123"}' > ~/.pinet/relay.json
```

Each token is scoped to a machine + team. Relay validates both. Tokens can expire. Admin can revoke individually.

## How this affects the relay

| Tier | Relay complexity | relay.json format |
|------|-------------------|-------------------|
| 1 (PoC) | `if (msg.token === TOKEN) OK` — 2 lines | `{ url, token }` |
| 2 | Signature verification — ~20 lines | `{ url, machine, privateKey }` |
| 3 | Token lookup + expiry — ~50 lines | `{ url, token }` (admin-managed) |

The relay code structure doesn't change — same `auth` message, same flow. Just the validation function gets more sophisticated.

## How this affects PiNet

It doesn't. PiNet reads `relay.json` and passes it to the sync daemon. The sync daemon handles auth with the relay. PiNet extension code is unchanged in all tiers.

## How this affects the sync daemon

| Tier | Sync daemon change |
|------|-------------------|
| 1 | Send `{ type: "auth", token: relayJson.token }` |
| 2 | Sign timestamp + machine with private key, send signature |
| 3 | Send token from relay.json |

The sync daemon reads `relay.json` and does the right thing based on which fields are present.

## Recommendation for implementation

**Ship Tier 1.** The relay validates `token === process.env.PINET_RELAY_TOKEN || config.token`. Sync daemon sends the token. Done in 5 minutes.

The `relay.json` schema already supports tier 2 (just add `machine` + `privateKey` fields). The relay auth function is one `if` statement that grows to a `verify()` function. No architectural changes needed for upgrade.

## Onboarding flow (all tiers)

```
Human decides to set up a PiNet network

1. Start relay:
   npx pinet-relay --port 3000 --token my-secret

2. On each machine, create relay.json:
   echo '{"url":"ws://relay-host:3000","token":"my-secret"}' > ~/.pinet/relay.json

3. Start sync daemon (or let extension auto-start it):
   npx pinet-sync

4. Agents log in as before:
   /pinet Master@build
   /pinet BackendDev@build
   ...

That's it. No key generation, no certificate authority, no admin panel.
The token IS the network. Share it however you share secrets with your team.
```

## Key insight

**Auth is not the same as identity.**

- **Auth** = "am I allowed to connect to this relay?" (machine → relay)
- **Identity** = "am I allowed to be Master?" (agent → network, via presence files)
- **Team membership** = "am I allowed to be in @build?" (agent → team, via meta.json)

These are three separate problems. The relay only cares about auth. PiNet handles identity and team membership via files. The sync daemon bridges them.

Don't over-engineer auth. The real security in PiNet is social: you trust the people running the agents. If you don't trust them, don't give them the token.
