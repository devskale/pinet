/**
 * PiNet — Permanent Agent Network
 *
 * Agent-to-agent DMs + team chats via files.
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
import * as fs from "node:fs";
import { pinetPath, readAllPresence, readJsonl, writePresence, writeIdentity, writeBinding, readBinding, generateName, joinTeam, readTeamMessages } from "./store";
import { resetWatchers, getPersonalLineCount, getTeamLineCount, startPersonalWatcher, startTeamWatcher, setWatcherIdentity } from "./watchers";
import { registerPersonalTools, registerTeamTools, setToolIdentity, resetToolIdentity } from "./tools";
import { TeamMessage } from "./types";

// =============================================================================
// State
// =============================================================================

let myName: string | null = null;
let myTeams: string[] = [];

// =============================================================================
// Parse "Name@team1,team2"
// =============================================================================

function parseLoginArg(arg: string): { name: string; teams: string[] } {
  const atIdx = arg.indexOf("@");
  if (atIdx === -1) return { name: arg, teams: [] };
  const name = arg.slice(0, atIdx);
  const teams = arg.slice(atIdx + 1).split(",").map((t) => t.trim()).filter(Boolean);
  return { name, teams };
}

// =============================================================================
// Status helpers
// =============================================================================

function getTeamUnread(teamName: string): number {
  return readTeamMessages(teamName)
    .slice(getTeamLineCount(teamName))
    .filter((m: TeamMessage) => m.from !== myName).length;
}

// =============================================================================
// Login / Logout
// =============================================================================

function doLogin(pi: ExtensionAPI, name: string, teams: string[], ctx: { hasUI: boolean; ui: any }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    if (ctx.hasUI) ctx.ui.notify("Invalid name. Use letters, numbers, underscore, hyphen.", "error");
    return;
  }

  for (const t of teams) {
    if (!/^[a-zA-Z0-9_-]+$/.test(t)) {
      if (ctx.hasUI) ctx.ui.notify(`Invalid team name "${t}".`, "error");
      return;
    }
  }

  // Check if name already online (different PID)
  const existingPath = pinetPath("presence", `${name}.json`);
  if (exists(existingPath)) {
    try {
      const existing = JSON.parse(read(existingPath));
      if (existing.status === "online" && isAlive(existing.pid) && existing.pid !== process.pid) {
        if (ctx.hasUI) ctx.ui.notify(`"${name}" is already online (PID ${existing.pid})`, "error");
        return;
      }
    } catch {}
  }

  // Set state
  myName = name;
  myTeams = teams;

  // Persist
  writeIdentity(name);
  writeBinding(name, teams);
  writePresence(name, "online");

  // Init modules
  setToolIdentity(name, teams);
  setWatcherIdentity(name);
  startPersonalWatcher(pi);
  registerPersonalTools(pi);

  const teamNotes: string[] = [];
  for (const team of teams) {
    joinTeam(team, name);
    startTeamWatcher(pi, team);
    teamNotes.push(`#${team}`);
  }
  if (teams.length > 0) {
    registerTeamTools(pi);
  }

  // Notify
  const mailbox = readJsonl(pinetPath("mailboxes", `${name}.mailbox.jsonl`));
  const backlog = mailbox.length - getPersonalLineCount();
  const parts = [`Logged in as ${name} ✨`];
  if (teamNotes.length > 0) parts.push(`Teams: ${teamNotes.join(", ")}`);
  if (backlog > 0) parts.push(`${backlog} unread DMs`);

  if (ctx.hasUI) ctx.ui.notify(parts.join("\n  "), "success");
}

function doLogout(ctx: { hasUI: boolean; ui: any }) {
  if (!myName) {
    if (ctx.hasUI) ctx.ui.notify("Not logged in.", "warning");
    return;
  }

  writePresence(myName, "offline");
  resetWatchers();
  resetToolIdentity();
  myName = null;
  myTeams = [];

  if (ctx.hasUI) ctx.ui.notify("Went offline.", "info");
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function read(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pinet", {
    description: "Log into PiNet: /pinet [name][@team1,team2] | /pinet off | /pinet (status)",

    handler: async (args, ctx) => {
      const arg = args.trim();

      // Logout
      if (arg === "off") {
        doLogout(ctx);
        return;
      }

      // Status (already logged in)
      if (!arg && myName) {
        const presence = readAllPresence();
        const peers = presence.filter((p) => p.status === "online" && p.name !== myName);
        const mailbox = readJsonl(pinetPath("mailboxes", `${myName}.mailbox.jsonl`));
        const unread = mailbox.length - getPersonalLineCount();

        const parts = [`Logged in as ${myName}`];
        if (myTeams.length > 0) {
          const teamStatus = myTeams.map((t) => {
            const u = getTeamUnread(t);
            return `#${t}${u > 0 ? ` (${u} unread)` : ""}`;
          });
          parts.push(`Teams: ${teamStatus.join(", ")}`);
        }
        parts.push(`${peers.length} peer${peers.length !== 1 ? "s" : ""} online`);
        if (unread > 0) parts.push(`${unread} unread DM${unread !== 1 ? "s" : ""}`);

        ctx.ui.notify(parts.join("\n  "), "info");
        return;
      }

      // No arg, not logged in → auto-login
      if (!arg && !myName) {
        const binding = readBinding();
        if (binding) {
          doLogin(pi, binding.name, binding.teams, ctx);
        } else {
          doLogin(pi, generateName(), [], ctx);
        }
        return;
      }

      // Already logged in
      if (myName) {
        ctx.ui.notify(`Already logged in as ${myName}. Use /pinet off first.`, "warning");
        return;
      }

      const { name, teams } = parseLoginArg(arg);
      doLogin(pi, name, teams, ctx);
    },
  });

  pi.on("session_shutdown", () => {
    if (myName) {
      writePresence(myName, "offline");
      resetWatchers();
    }
  });
}
