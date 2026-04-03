/**
 * PiNet — Permanent Agent Network
 *
 * Agent-to-agent DMs + team chats via files. Zero server.
 *
 * Usage:
 *   /pinet                       — auto-login (binding or generated name)
 *   /pinet <name>                — log in (DMs only)
 *   /pinet <name>@<team>         — log in + join/create team
 *   /pinet <name>@<t1>,<t2>      — log in + join multiple teams
 *   /pinet                       — show status (when logged in)
 *   /pinet off                   — go offline
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as child_process from "node:child_process";
import * as path from "node:path";
import {
  pinetPath, exists, readFile, isProcessAlive,
  readAllPresence, readJsonl, readTeamMessages,
  writePresence, writeIdentity, writeBinding, readBinding,
  generateName, joinTeam,
} from "./store";
import { NAME_PATTERN, TeamMessage } from "./types";
import {
  startPersonalWatcher, startTeamWatcher,
  resetWatchers, getPersonalLineCount, getTeamLineCount,
  setWatcherIdentity,
} from "./watchers";
import {
  registerPersonalTools, registerTeamTools,
  setToolIdentity, resetToolIdentity,
} from "./tools";

// =============================================================================
// State
// =============================================================================

let myName: string | null = null;
let myTeams: string[] = [];
let syncProcess: child_process.ChildProcess | null = null;

// =============================================================================
// Parse "Name@team1,team2"
// =============================================================================

function parseLoginArg(arg: string): { name: string; teams: string[] } {
  const at = arg.indexOf("@");
  if (at === -1) return { name: arg, teams: [] };
  return {
    name: arg.slice(0, at),
    teams: arg
      .slice(at + 1)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

// =============================================================================
// Unread count helper
// =============================================================================

function teamUnread(team: string): number {
  return readTeamMessages(team)
    .slice(getTeamLineCount(team))
    .filter((m: TeamMessage) => m.from !== myName).length;
}

// =============================================================================
// Login
// =============================================================================

function doLogin(pi: ExtensionAPI, name: string, teams: string[], ctx: any) {
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
  if (exists(presenceFile)) {
    try {
      const pe = JSON.parse(readFile(presenceFile));
      if (pe.status === "online" && isProcessAlive(pe.pid) && pe.pid !== process.pid) {
        ctx.ui?.notify?.(`"${name}" is already online (PID ${pe.pid})`, "error");
        return;
      }
    } catch { /* stale file, proceed */ }
  }

  // Set identity
  myName = name;
  myTeams = teams;

  // Persist
  writeIdentity(name);
  writeBinding(name, teams);
  writePresence(name, "online");

  // Init subsystems
  setToolIdentity(name, teams);
  setWatcherIdentity(name);
  startPersonalWatcher(pi);
  registerPersonalTools(pi);

  for (const team of teams) {
    joinTeam(team, name);
    startTeamWatcher(pi, team);
  }
  if (teams.length > 0) registerTeamTools(pi);

  // Start sync daemon if relay.json exists
  startSyncDaemon(ctx);

  // Notify user
  const backlog =
    readJsonl(pinetPath("mailboxes", `${name}.mailbox.jsonl`)).length -
    getPersonalLineCount();

  const lines = [`Logged in as ${name} ✨`];
  if (teams.length > 0) lines.push(`Teams: ${teams.map((t) => `#${t}`).join(", ")}`);
  if (backlog > 0) lines.push(`${backlog} unread DMs`);

  ctx.ui?.notify?.(lines.join("\n  "), "success");
}

// =============================================================================
// Logout
// =============================================================================

function doLogout(ctx: any) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }

  writePresence(myName, "offline");
  resetWatchers();
  resetToolIdentity();
  stopSyncDaemon();

  const name = myName;
  myName = null;
  myTeams = [];

  ctx.ui?.notify?.(`${name} went offline.`, "info");
}

// =============================================================================
// Status
// =============================================================================

function showStatus(ctx: any) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }

  const peers = readAllPresence().filter(
    (p) => p.status === "online" && p.name !== myName
  );
  const dmUnread =
    readJsonl(pinetPath("mailboxes", `${myName}.mailbox.jsonl`)).length -
    getPersonalLineCount();

  const lines = [`Logged in as ${myName}`];
  if (myTeams.length > 0) {
    lines.push(
      `Teams: ${myTeams
        .map((t) => {
          const u = teamUnread(t);
          return `#${t}${u > 0 ? ` (${u} unread)` : ""}`;
        })
        .join(", ")}`
    );
  }
  lines.push(`${peers.length} peer${peers.length !== 1 ? "s" : ""} online`);
  if (dmUnread > 0) lines.push(`${dmUnread} unread DM${dmUnread !== 1 ? "s" : ""}`);

  ctx.ui?.notify?.(lines.join("\n  "), "info");
}

// =============================================================================
// Sync daemon (relay bridge)
// =============================================================================

function startSyncDaemon(ctx: any) {
  const relayConfig = pinetPath("relay.json");
  if (!exists(relayConfig)) return; // no relay configured, local only

  if (syncProcess && !syncProcess.killed) return; // already running

  const syncPath = path.join(__dirname, "sync.js");
  if (!exists(syncPath)) {
    ctx.ui?.notify?.("sync.js not found — relay sync disabled", "warning");
    return;
  }

  syncProcess = child_process.fork(syncPath, [], {
    stdio: "pipe",
    detached: false,
  });

  syncProcess.on("error", (err) => {
    ctx.ui?.notify?.(`Sync daemon error: ${err.message}`, "error");
    syncProcess = null;
  });

  syncProcess.on("exit", (code) => {
    if (code && code !== 0) {
      ctx.ui?.notify?.(`Sync daemon exited (code ${code})`, "warning");
    }
    syncProcess = null;
  });

  ctx.ui?.notify?.("Sync daemon started — relay bridge active", "info");
}

function stopSyncDaemon() {
  if (syncProcess && !syncProcess.killed) {
    syncProcess.kill();
    syncProcess = null;
  }
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pinet", {
    description: "PiNet: /pinet [name][@team] | /pinet off | /pinet (status)",

    handler: async (args, ctx) => {
      const arg = args.trim();

      // ── Logout ──────────────────────────────────
      if (arg === "off") return doLogout(ctx);

      // ── Status ──────────────────────────────────
      if (!arg && myName) return showStatus(ctx);

      // ── Auto-login ──────────────────────────────
      if (!arg && !myName) {
        const binding = readBinding();
        return doLogin(
          pi,
          binding ? binding.name : generateName(),
          binding ? binding.teams : [],
          ctx
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
      const { name, teams } = parseLoginArg(arg);
      doLogin(pi, name, teams, ctx);
    },
  });

  // Cleanup on exit
  pi.on("session_shutdown", () => {
    if (myName) {
      writePresence(myName, "offline");
      resetWatchers();
    }
    stopSyncDaemon();
  });
}
