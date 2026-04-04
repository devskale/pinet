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

import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as child_process from "node:child_process";
import * as path from "node:path";
import {
  pinetPath, exists, readFile, isProcessAlive,
  readAllPresence, readJsonl, readJson, appendJsonl, readTeamMessages,
  writePresence, writeIdentity, writeBinding, readBinding,
  generateName, joinTeam,
} from "./store";
import { NAME_PATTERN, TeamMessage } from "./types";
import {
  startPersonalWatcher, startTeamWatcher,
  resetWatchers, getPersonalLineCount, getTeamLineCount,
  bumpTeamLineCount, setWatcherIdentity,
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
  return readTeamMessages(team)
    .slice(getTeamLineCount(team))
    .filter((m: TeamMessage) => m.from !== myName).length;
}

// =============================================================================
// Login
// =============================================================================

function doLogin(pi: ExtensionAPI, name: string, teams: string[], teamRoles: Record<string, string>, ctx: any, force: boolean = false) {
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
    joinTeam(team, name, teamRoles[team]);
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

  // Presence heartbeat — refresh lastSeen every 30s
  const heartbeat = setInterval(() => {
    if (myName) writePresence(myName, "online");
    else clearInterval(heartbeat);
  }, 30_000);
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
    env: { ...process.env, PINET_AGENT_NAME: myName || "" },
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

function doWhoami(ctx: any) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }
  const teams = myTeams.length > 0 ? myTeams.map(t => {
    const meta = readJson(pinetPath("teams", t, "meta.json")) as any;
    const role = meta?.roles?.[myName] || "member";
    return `#${t} (${role})`;
  }).join(", ") : "none";
  ctx.ui?.notify?.(`${myName} — Teams: ${teams}`, "info");
}

function doMsg(args: string, ctx: any) {
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

  const target = args.slice(0, spaceIdx).trim().replace(/[,:;!]+$/, "");
  const body = args.slice(spaceIdx + 1).trim();

  if (!target || !body) {
    ctx.ui?.notify?.("Usage: /pinet msg <agent> <message>", "warning");
    return;
  }

  // Find a shared team with this agent
  const team = myTeams.find(t => {
    const meta = readJson(pinetPath("teams", t, "meta.json")) as any;
    return meta?.members?.includes(target);
  });

  if (!team) {
    ctx.ui?.notify?.(`No shared team with "${target}". Both must be in the same team.`, "warning");
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
  ctx.ui?.notify?.(`→ #${team} @${target}: ${body}`, "info");
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pinet", {
    description: "PiNet: /pinet [name][@team] | off | msg <agent> <text> | whoami",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const subcommands = ["off", "msg", "whoami"];

      // First word — subcommand or login pattern
      if (!prefix.includes(" ")) {
        const items = [...subcommands, ...subcommands];
        // If typing "msg ", suggest agents
        if (prefix === "msg" || prefix.startsWith("msg ")) {
          return null; // fall through to second-word logic
        }
        const matches = items.filter(i => i.startsWith(prefix));
        if (matches.length > 0) return matches.map(m => ({ value: m, label: m }));
        return null;
      }

      // After "msg " — suggest online agents as target
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
      if (arg === "whoami") return doWhoami(ctx);

      // ── Send message to team member ────────────
      if (arg.startsWith("msg ")) return doMsg(arg.slice(4).trim(), ctx);

      // ── Force override ───────────────────────────
      const force = arg.startsWith("--force");
      const cleanArg = force ? arg.replace(/--force\s*/, "").trim() : arg;
      const effectiveArg = cleanArg;

      // ── Status ──────────────────────────────────
      if (!effectiveArg && myName) return showStatus(ctx);

      // ── Auto-login ──────────────────────────────
      if (!effectiveArg && !myName) {
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
      const { name, teams, teamRoles } = parseLoginArg(effectiveArg);
      doLogin(pi, name, teams, teamRoles, ctx, force);
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
