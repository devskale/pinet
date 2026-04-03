# File Shares — Brainstorm: Agent Collaboration on Markdown Files

## Current Infrastructure

### Samba over Tailscale (lubu)

| Item | Value |
|------|-------|
| Server | lubu (Lubuntu 24.10, 4 cores, 3.5GB RAM) |
| VPN | Tailscale |
| Shares | `//lubuntu/storage1` (458GB), `//lubuntu/storage2` (458GB) |
| Ports | SMB 139/445 |
| Access | Tailscale IP (not public internet) |
| Mac mount | `~/mnt/lubu/` (currently empty/unmounted) |

### Syncthing

| Item | Value |
|------|-------|
| lubu | port 8385→8384, `//lubuntu/storage1` |
| amd1 | port 8384 |
| Model | P2P, continuous sync |

### WebDAV (amd1)

| Item | Value |
|------|-------|
| Server | amd1 (Oracle Cloud) |
| Software | dufs on port 5000 |
| URL | `https://amd1.mooo.com/klark0/` |
| Backend | `~/sync/klark0` |
| Mac mount | `~/mnt/webdav/` (currently empty/unmounted) |

### Jot (lubu)

| Item | Value |
|------|-------|
| Server | lubu, port 3210 (localhost only) |
| External | `https://neusiedl.duckdns.org:8001/jot/` via nginx |
| Data | `/var/lib/jot/data/notes/` (JSON + derived .md) |
| Collab | Real-time WebSocket + semantic CRDT (articulated) |
| Auth | Owner password, API keys, share links |

---

## Problem Statement

Multiple pi agents need to collaborate on the **same markdown file**. They run as separate processes (separate pi sessions, possibly on different machines) with no persistent connection between tool calls.

Current options each have trade-offs:

---

## Method A: Jot Shared Notes (REST API)

**How it works:** Agents hit jot's REST API via HTTPS. Each agent registers with a share link scoped to one note.

```
Agent A: POST /api/share/<id>/edit  {edits: [{oldText, newText}]}
Agent B: POST /api/share/<id>/edit  {edits: [{oldText, newText}]}
```

**Pros:**
- Real collab engine with conflict resolution (articulated CRDT)
- Comment threads, share access control
- Already deployed and working
- Works over public internet (no VPN needed)
- Browser can also view/edit simultaneously

**Cons:**
- Agents can't see each other's edits in real-time via REST (no push)
- Read-stale-edit race condition (must re-read before every edit)
- "oldText not found" errors under concurrent edits
- Single point of failure (jot server on lubu)
- Self-signed SSL cert needs `NODE_TLS_REJECT_UNAUTHORIZED=0`
- Text-based edits only (oldText/newText matching) — no direct file write
- .md files are derived artifacts, not source of truth (JSON is)

**Mitigations:**
- Read-before-write + retry on conflict
- pi-messenger coordination (reserve/release, broadcast edits)

---

## Method B: Jot WebSocket Daemon (conceptJotWebsocket.md)

**How it works:** Each agent runs a background daemon (`jot-ws.mjs`) that maintains a persistent WebSocket connection. Pi talks to the daemon via Unix socket + state file.

```
Agent A → jot-ws.mjs (daemon) → WebSocket → Jot server ← WebSocket ← jot-ws.mjs ← Agent B
```

**Pros:**
- Real-time: agents see each other's edits instantly via server broadcast
- No stale-state problem (daemon always has latest markdown)
- True collaborative editing with identity (clientId, name, color, presence)
- Semantic mutations with stable element IDs (no oldText matching)
- Comment threads still work

**Cons:**
- Complex: daemon process management, crash recovery, reconnect logic
- Requires background process per agent per note
- Self-signed SSL workaround needed
- Daemon must run for the duration of the session
- More moving parts (Unix socket, state file, PID management)
- Still single point of failure (jot server)

---

## Method C: Samba/Tailscale Shared Filesystem

**How it works:** Markdown files live on lubu's Samba share, mounted on all agent machines via Tailscale VPN. Agents read/write the file directly from the local mount.

```
lubu: /srv/storage1/notes/file.md
Agent A: ~/mnt/lubu/notes/file.md  (Tailscale + SMB mount)
Agent B: ~/mnt/lubu/notes/file.md  (Tailscale + SMB mount)
```

**Pros:**
- Simple: agents just read/write files with standard tools
- No server, no daemon, no API
- Works offline (Samba caches)
- Fast for small files
- Can use any file format, not just markdown
- macOS native SMB support (Finder, CLI)

**Cons:**
- **No conflict detection** — last write wins, silent data loss
- **No merging** — concurrent edits overwrite each other
- **No notifications** — agents don't know when file changes
- Tailscale must be running on all machines
- SMB can be flaky on macOS (mount drops, permissions issues)
- File locking is advisory, not enforced across machines
- No comment threads, no share access control
- No audit trail (who changed what, when)

**Mitigations:**
- pi-messenger for coordination (reserve before edit, broadcast after)
- Append-only pattern (each agent appends to a section)
- File locking via pi-messenger's claim/unclaim mechanism

---

## Method D: Syncthing P2P Sync

**How it works:** Files sync between machines via Syncthing's P2P protocol. Each machine has a local copy. Agents edit locally, Syncthing propagates changes.

```
Agent A (local): ~/sync/notes/file.md  ←→  Syncthing  ←→  ~/sync/notes/file.md :Agent B (local)
```

**Pros:**
- Decentralized — no central server
- Works offline, syncs when online
- Versioning via Syncthing's file versioning feature
- Fast local reads (no network latency)
- Already running on lubu and amd1

**Cons:**
- **Same conflict problem as Samba** — concurrent edits = sync conflicts ( Syncthing creates `.sync-conflict` files)
- **No merge** — conflicts are duplicate files, must be resolved manually
- **No notifications** — agents don't know when file changes
- Sync delay (typically seconds, not instant)
- Requires Syncthing installed and configured on every agent machine
- Conflict files pollute the directory

**Mitigations:**
- pi-messenger coordination (same as Samba)
- Syncthing's "simple versioning" keeps last N versions

---

## Method E: WebDAV (amd1 dufs)

**How it works:** Files stored on amd1's dufs WebDAV server. Agents read/write via HTTP (PUT/GET).

```
Agent A: GET  https://amd1.mooo.com/klark0/notes/file.md
Agent B: PUT  https://amd1.mooo.com/klark0/notes/file.md
```

**Pros:**
- Simple HTTP API (GET/PUT/DELETE)
- Works over public internet
- dufs is lightweight, already deployed
- No VPN needed

**Cons:**
- **Same conflict problem** — PUT overwrites, last write wins
- **No merge, no conflict detection**
- **No notifications**
- Single point of failure (amd1)
- No collaborative editing features
- dufs doesn't support WebDAV locking well

---

## Method F: Git (shared repo)

**How it works:** Markdown files in a git repo. Agents commit and push/pull.

```
Agent A: git pull → edit → git commit → git push
Agent B: git pull → edit → git commit → git push
```

**Pros:**
- Full history, diff, blame, revert
- Branching for parallel work
- Merge tools available
- Well-understood, battle-tested
- Works with pi-messenger (commit events in feed)

**Cons:**
- **Merge conflicts** on concurrent edits to same section
- Requires manual conflict resolution (agents aren't great at this)
- Push/pull cycle adds latency
- No real-time collaboration
- Requires git literacy in the agent's workflow
- Repo must be hosted somewhere (GitHub, local bare repo, etc.)

**Mitigations:**
- pi-messenger for coordination (claim sections before editing)
- Append-only sections to avoid conflicts
- One agent owns the file, others send patches via comments

---

## Method G: Pi-Messenger Filesystem Coordination (no external service)

**How it works:** Files live on a shared filesystem (Samba, Syncthing, or even local). Pi-messenger provides the coordination layer that the filesystem lacks.

```
1. Agent A: pi_messenger({ action: "reserve", paths: ["notes/file.md"] })
2. Agent A: read file, edit, write file
3. Agent A: pi_messenger({ action: "send", to: "AgentB", message: "Updated section X" })
4. Agent B: receives message, re-reads file
5. Agent A: pi_messenger({ action: "release" })
```

**Pros:**
- Uses existing pi-messenger infrastructure (no new services)
- Works with any underlying filesystem (Samba, Syncthing, local, etc.)
- Claim system prevents concurrent writes (file-level mutex)
- Broadcast/messaging for awareness
- Activity feed for audit trail
- Already integrated into pi's agent lifecycle

**Cons:**
- **Coarse-grained locking** — reserves whole files, not sections
- **Eventual consistency** — agent B only knows about changes when it receives a message
- **No merge** — if two agents need to edit different parts of the same file, they must serialize
- Depends on pi-messenger being active in all agent sessions
- Doesn't solve the underlying filesystem's limitations

**Mitigations:**
- Section-level reservation (reserve "notes/file.md:lines-10-20")
- Append-only pattern (no reservation needed)
- Combine with git for history

---

## Comparison Matrix

| Method | Real-time | Conflict handling | Notifications | Complexity | Infrastructure | Pi integration |
|--------|-----------|-------------------|---------------|------------|---------------|----------------|
| A: Jot REST | ❌ | Server-side (oldText match) | ❌ | Low | Jot server | Bash + curl |
| B: Jot WS daemon | ✅ | Server-side (CRDT) | ✅ | High | Jot server + daemon | Bash + Unix socket |
| C: Samba/Tailscale | ❌ | Last write wins | ❌ | Low | SMB + VPN | Direct file access |
| D: Syncthing | ❌ (seconds) | Conflict files | ❌ | Low | Syncthing | Direct file access |
| E: WebDAV | ❌ | Last write wins | ❌ | Low | dufs server | Bash + curl |
| F: Git | ❌ | Merge conflicts | ❌ (push) | Medium | Git hosting | Bash + git |
| G: Pi-messenger coord | ❌ | File reservation | ✅ (messaging) | Low | Pi-messenger | Native |

---

## Hybrid Possibilities

### Jot + Pi-Messenger (A or B + G)
- Use jot for the collab engine (conflict resolution, comments, browser UI)
- Use pi-messenger for agent coordination (who's editing what, handoff)
- Method A for simplicity, Method B for real-time needs

### Samba + Pi-Messenger (C + G)
- Files on Samba share for universal access
- Pi-messenger for coordination (reserve/release, edit broadcasts)
- Simple, no extra services needed
- Good for append-only or section-separated documents

### Git + Pi-Messenger (F + G)
- Git for history and branching
- Pi-messenger for coordination (claim before edit, broadcast commits)
- Feed already logs commits
- Best for structured, version-controlled content

### Samba + Jot (C + A)
- Mount jot's `/var/lib/jot/data/notes/` via Samba for direct file access
- Also use jot API for structured edits when needed
- Risk: writing .md directly bypasses collab state (JSON is source of truth)

---

## Open Questions

1. **What's the typical edit pattern?** Sequential (one agent at a time) or concurrent (overlapping regions)?
2. **How many agents?** 2-3 (manageable with coordination) or 10+ (needs proper CRDT)?
3. **Does the human need to see/edit in the browser too?** (favors jot)
4. **Are edits to the same section or different sections?** (section-level locking vs full-file locking)
5. **Is append-only acceptable?** (eliminates most conflicts)
6. **What's the latency tolerance?** Instant (WebSocket) vs seconds (polling) vs minutes (eventual)?
7. **Which machines do agents run on?** All on Mac? Some on lubu/amd1?
