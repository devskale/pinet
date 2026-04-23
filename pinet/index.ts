/**
 * PiNet — Agent Network
 *
 * Usage:
 *   /pinet <name>[@<team>]   — log in
 *   /pinet                   — status (logged in) or auto-login (not logged in)
 *   /pinet off               — go offline
 *   /pinet msg <agent> <msg> — send to teammate
 */

import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  pinetPath, exists, readFile, isProcessAlive,
  readAllPresence, readJsonl, readJson, appendJsonl, readTeamMessages,
  writePresence, writeIdentity, writeBinding, readBinding,
  generateName, joinTeam, readDeliveryMode,
} from "./store";
import { NAME_PATTERN, TeamMessage, TeamMeta } from "./types";
import {
  initPersonalPointer, initTeamPointer,
  resetPointers, getPersonalLineCount, getTeamLineCount,
  bumpTeamLineCount, setPointerIdentity,
} from "./read-state";
import {
  registerPersonalTools, registerTeamTools,
  setToolIdentity, resetToolIdentity,
} from "./tools";

// =============================================================================
// Types
// =============================================================================

interface CommandContext {
  ui?: {
    notify?: (message: string, type: string) => void;
  };
}

// =============================================================================
// State
// =============================================================================

let myName: string | null = null;
let myTeams: string[] = [];
let syncProcess: child_process.ChildProcess | null = null;
let piRef: ExtensionAPI | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let presenceSweeperTimer: ReturnType<typeof setInterval> | null = null;
let syncConnected = false;   // has the sync daemon confirmed a relay connection?
let syncFatalSeen = false;   // did the sync daemon report a fatal auth failure?

// =============================================================================
// Parse "Name@team1,team2"
// =============================================================================

function parseLoginArg(arg: string): { name: string; teams: string[]; teamRoles: Record<string, string> } {
  const at = arg.indexOf("@");
  if (at === -1) return { name: arg, teams: [], teamRoles: {} };
  const teamRoles: Record<string, string> = {};
  const teams = arg
    .slice(at + 1)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const colon = t.indexOf(":");
      if (colon !== -1) {
        const teamName = t.slice(0, colon);
        teamRoles[teamName] = t.slice(colon + 1);
        return teamName;
      }
      return t;
    });
  return { name: arg.slice(0, at), teams, teamRoles };
}

// =============================================================================
// Unread count helper
// =============================================================================

function teamUnread(team: string): number {
  return readTeamMessages(team, getTeamLineCount(team))
    .filter((m: TeamMessage) => m.from !== myName).length;
}

// =============================================================================
// Discovery — show everything at login and on status
// =============================================================================

function showDiscovery(ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in. Use /pinet <name>[@<team>]", "warning");
    return;
  }

  const peers = readAllPresence();
  const onlinePeers = peers.filter(p => p.status === "online" && p.name !== myName);
  const dmUnread = readJsonl(pinetPath("mailboxes", `${myName}.mailbox.jsonl`), getPersonalLineCount()).length;

  const lines: string[] = [];

  // Line 1: identity
  const teamPart = myTeams.length > 0 ? " " + myTeams.map(t => `#${t}`).join(", ") : "";
  lines.push(`${myName}${teamPart}`);

  // Line 2: peers
  if (onlinePeers.length > 0) {
    lines.push(onlinePeers.map(p => `● ${p.name}`).join("  "));
  } else {
    lines.push("no other agents online");
  }

  // Line 3: unread
  const unreadParts: string[] = [];
  if (dmUnread > 0) unreadParts.push(`${dmUnread} DM${dmUnread !== 1 ? "s" : ""}`);
  for (const t of myTeams) {
    const u = teamUnread(t);
    if (u > 0) unreadParts.push(`${u} in #${t}`);
  }
  if (unreadParts.length > 0) {
    lines.push(unreadParts.join(" · "));
  }

  ctx.ui?.notify?.(lines.join("\n"), myTeams.length > 0 ? "success" : "info");
}

// =============================================================================
// Login
// =============================================================================

function doLogin(pi: ExtensionAPI, name: string, teams: string[], teamRoles: Record<string, string>, ctx: CommandContext, force: boolean = false) {
  // Validate
  if (!NAME_PATTERN.test(name)) {
    ctx.ui?.notify?.("Invalid name. Use letters, numbers, _ or -.", "error");
    return;
  }
  for (const t of teams) {
    if (!NAME_PATTERN.test(t)) {
      ctx.ui?.notify?.(`Invalid team name "${t}".`, "error");
      return;
    }
  }

  // Check name conflict
  const presenceFile = pinetPath("presence", `${name}.json`);
  if (!force && exists(presenceFile)) {
    try {
      const pe = JSON.parse(readFile(presenceFile));
      if (pe.status === "online" && isProcessAlive(pe.pid) && pe.pid !== process.pid) {
        ctx.ui?.notify?.(`"${name}" is already online (PID ${pe.pid}). Use /pinet off first, or /pinet --force ${name} to override.`, "error");
        return;
      }
    } catch { /* stale file, proceed */ }
  }

  // Set identity
  myName = name;
  myTeams = teams;
  syncConnected = false;
  syncFatalSeen = false;

  // Persist
  writeIdentity(name);
  writeBinding(name, teams);
  writePresence(name, "online");

  // Init subsystems
  setToolIdentity(name, teams);
  setPointerIdentity(name);
  initPersonalPointer();
  registerPersonalTools(pi);

  for (const team of teams) {
    joinTeam(team, name, teamRoles[team]);
    initTeamPointer(team);
  }
  if (teams.length > 0) registerTeamTools(pi);

  // Start sync daemon if relay.json exists
  const relayConfigured = exists(pinetPath("relay.json"));
  startSyncDaemon(ctx);

  // Notify user
  const backlog =
    readJsonl(pinetPath("mailboxes", `${name}.mailbox.jsonl`), getPersonalLineCount()).length;

  // If a relay is configured, the sync daemon will announce the REAL online
  // status once it connects (or an error if the relay refuses). Say
  // "connecting..." meanwhile. Local-only (no relay) → announce online now.
  if (relayConfigured) {
    const parts = [`${name} connecting…`];
    if (teams.length > 0) parts.push(teams.map((t) => `#${t}`).join(", "));
    ctx.ui?.notify?.(parts.join(" "), "info");
  } else {
    const lines = [`${name} online (local)`];
    if (teams.length > 0) lines.push(teams.map((t) => `#${t}`).join(", "));
    if (backlog > 0) lines.push(`${backlog} DMs`);
    ctx.ui?.notify?.(lines.join(" "), "success");
  }

  // Presence heartbeat — refresh lastSeen every 30s
  heartbeatTimer = setInterval(() => {
    if (myName) writePresence(myName, "online");
    else if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }, 30_000);

  // Presence sweeper — clean up stale entries every 60s
  presenceSweeperTimer = setInterval(() => { readAllPresence(); }, 60_000);
}

// =============================================================================
// Logout
// =============================================================================

function doLogout(ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }

  writePresence(myName, "offline");
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (presenceSweeperTimer) { clearInterval(presenceSweeperTimer); presenceSweeperTimer = null; }
  resetPointers();
  resetToolIdentity();
  stopSyncDaemon();

  const name = myName;
  myName = null;
  myTeams = [];

  ctx.ui?.notify?.(`${name} offline`, "info");
}

// =============================================================================
// Status
// =============================================================================

function showStatus(ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }

  const peers = readAllPresence().filter(
    (p) => p.status === "online" && p.name !== myName
  );
  const dmUnread =
    readJsonl(pinetPath("mailboxes", `${myName}.mailbox.jsonl`), getPersonalLineCount()).length;

  const lines = [`${myName}${syncConnected ? "" : " (offline on relay)"}`];
  if (myTeams.length > 0) {
    lines.push(
      myTeams
        .map((t) => {
          const u = teamUnread(t);
          return `#${t}${u > 0 ? ` (${u})` : ""}`;
        })
        .join(", ")
    );
  }
  lines.push(`${peers.length} peer${peers.length !== 1 ? "s" : ""}`);
  if (dmUnread > 0) lines.push(`${dmUnread} DMs`);

  ctx.ui?.notify?.(lines.join(" "), "info");
}

// =============================================================================
// Sync daemon (relay bridge)
// =============================================================================

function startSyncDaemon(ctx: CommandContext) {
  const relayConfig = pinetPath("relay.json");
  if (!exists(relayConfig)) return;

  if (syncProcess && !syncProcess.killed) return;

  const syncPath = path.join(__dirname, "sync.mjs");
  if (!exists(syncPath)) return;

  if (!myName) return;

  syncProcess = child_process.fork(syncPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    detached: false,
    env: { ...process.env, PINET_AGENT_NAME: myName },
  });

  syncProcess.on("error", (err) => {
    ctx.ui?.notify?.(`Sync daemon error: ${err.message}`, "error");
    syncProcess = null;
  });

  syncProcess.on("exit", (code) => {
    // Only report if we never heard a fatal status from the daemon (which
    // already exited with this code and surfaced a clear reason).
    if (code && code !== 0 && !syncFatalSeen) {
      ctx.ui?.notify?.(`Sync daemon exited (code ${code})`, "warning");
    }
    syncProcess = null;
  });

  // Truthful relay status: announce online/error based on what the sync
  // daemon actually reports, not on optimistic assumptions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  syncProcess.on("message", (msg: any) => {
    if (msg.type === "pinet-status") {
      if (msg.status === "online") {
        syncConnected = true;
        const parts = [`${myName} online`, myTeams.map((t) => `#${t}`).join(", ") || ""];
        if (msg.agents != null) parts.push(`(${msg.agents} on relay)`);
        ctx.ui?.notify?.(parts.filter(Boolean).join(" "), "success");
      } else {
        // offline (transient reconnect or fatal)
        syncConnected = false;
        if (msg.fatal) {
          syncFatalSeen = true;
          ctx.ui?.notify?.(`Not online — relay rejected: ${msg.reason} (code ${msg.code})`, "error");
        }
        // transient: silent — the daemon will reconnect and report online again
      }
      return;
    }
    if (msg.type !== "pinet-deliver") return;
    if (!myName || !piRef) return;

    if (msg.channel === "team" && msg.lines) {
      const teamName = (msg.path as string)?.split("/")[1];
      const incoming = (msg.lines as unknown[])
        .map((l) => {
          if (typeof l === "string") { try { return JSON.parse(l); } catch { return null; } }
          return l;
        })
        .filter((m): m is { from: string; body: string } => m != null && m.from !== myName);
      if (incoming.length === 0 || !teamName) return;
      const summary = incoming.map((m) => `receive from ${m.from}@${teamName}: ${m.body}`).join("\n");
      const mode = readDeliveryMode(teamName);
      piRef.sendMessage({ customType: "pinet-team", content: summary, display: true }, { triggerTurn: mode === "interrupt" });
    }

    if (msg.channel === "write") {
      const summary = `receive from ${msg.from as string}: ${(msg.content as string) ?? ""}`;
      piRef.sendMessage({ customType: "pinet", content: summary, display: true }, { triggerTurn: true });
    }
  });
}

function stopSyncDaemon() {
  if (syncProcess && !syncProcess.killed) {
    syncProcess.kill();
    syncProcess = null;
  }
}

// =============================================================================
// /pinet msg — send to teammate
// =============================================================================

function doMsg(args: string, ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in. Use /pinet <name>@<team> first.", "warning");
    return;
  }
  if (!args) {
    ctx.ui?.notify?.("Usage: /pinet msg <agent> <message>", "warning");
    return;
  }

  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) {
    ctx.ui?.notify?.("Usage: /pinet msg <agent> <message>", "warning");
    return;
  }

  const targetSpec = args.slice(0, spaceIdx).trim().replace(/[,:;!]+$/, "");
  const body = args.slice(spaceIdx + 1).trim();

  if (!targetSpec || !body) {
    ctx.ui?.notify?.("Usage: /pinet msg <agent> <message>", "warning");
    return;
  }

  // Parse optional @team suffix
  let target = targetSpec;
  let teamHint: string | undefined;
  const atIdx = targetSpec.lastIndexOf("@");
  if (atIdx !== -1) {
    target = targetSpec.slice(0, atIdx);
    teamHint = targetSpec.slice(atIdx + 1);
  }

  // Find shared team with this agent
  const sharedTeams = myTeams.filter(t => {
    const meta = readJson<TeamMeta>(pinetPath("teams", t, "meta.json"));
    return meta?.members?.includes(target);
  });

  if (sharedTeams.length === 0) {
    ctx.ui?.notify?.(`No shared team with "${target}". Both must be in the same team.`, "warning");
    return;
  }

  let team: string;
  if (teamHint) {
    if (!sharedTeams.includes(teamHint)) {
      ctx.ui?.notify?.(`No shared team #${teamHint} with "${target}". Shared: ${sharedTeams.map(t => `#${t}`).join(", ")}.`, "warning");
      return;
    }
    team = teamHint;
  } else if (sharedTeams.length === 1) {
    team = sharedTeams[0];
  } else {
    ctx.ui?.notify?.(
      `Ambiguous — ${sharedTeams.length} shared teams with "${target}": ${sharedTeams.map(t => `#${t}`).join(", ")}. ` +
      `Use /pinet msg ${target}@<team> <message>`,
      "warning"
    );
    return;
  }

  const msg = {
    id: crypto.randomUUID(),
    from: myName,
    body: `@${target} ${body}`,
    timestamp: new Date().toISOString(),
  };

  appendJsonl(pinetPath("teams", team, "messages.jsonl"), msg);
  bumpTeamLineCount(team);
  ctx.ui?.notify?.(`send to ${myName}@${team} @${target}: ${body}`, "info");
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.registerCommand("pinet", {
    description: "PiNet: /pinet [name][@team] | off | msg | status",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const subcommands = ["off", "msg"];

      if (!prefix.includes(" ")) {
        const matches = subcommands.filter(i => i.startsWith(prefix));
        if (matches.length > 0) return matches.map(m => ({ value: m, label: m }));
        return null;
      }

      // After "msg " — suggest online agents
      const parts = prefix.split(" ");
      if (parts[0] === "msg" && parts.length === 2 && !parts[1].includes(" ")) {
        const agents = readAllPresence().filter(p => p.status === "online" && p.name !== myName).map(p => p.name);
        const filtered = agents.filter(a => a.toLowerCase().startsWith(parts[1].toLowerCase()));
        if (filtered.length > 0) return filtered.map(a => ({ value: `msg ${a} `, label: a }));
      }

      return null;
    },

    handler: async (args, ctx) => {
      const arg = args.trim();

      // ── Logout ──────────────────────────────────
      if (arg === "off") return doLogout(ctx);

      // ── Send message to teammate ────────────────
      if (arg.startsWith("msg ")) return doMsg(arg.slice(4).trim(), ctx);

      // ── Force override ──────────────────────────
      const force = arg.startsWith("--force");
      const cleanArg = force ? arg.replace(/--force\s*/, "").trim() : arg;

      // ── Status (logged in) ──────────────────────
      if (!cleanArg && myName) return showDiscovery(ctx);

      // ── Auto-login (not logged in) ──────────────
      if (!cleanArg && !myName) {
        const binding = readBinding();
        return doLogin(
          pi,
          binding ? binding.name : generateName(),
          binding ? binding.teams : [],
          {},
          ctx,
          force
        );
      }

      // ── Already logged in ───────────────────────
      if (myName) {
        ctx.ui?.notify?.(
          `Already logged in as ${myName}. Use /pinet off first.`,
          "warning"
        );
        return;
      }

      // ── Login with arg ──────────────────────────
      const { name, teams, teamRoles } = parseLoginArg(cleanArg);
      doLogin(pi, name, teams, teamRoles, ctx, force);
    },
  });

  // Cleanup on exit
  pi.on("session_shutdown", () => {
    if (myName) {
      writePresence(myName, "offline");
      resetPointers();
    }
    if (presenceSweeperTimer) { clearInterval(presenceSweeperTimer); presenceSweeperTimer = null; }
    stopSyncDaemon();
  });
}
