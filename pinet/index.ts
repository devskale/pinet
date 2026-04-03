/**
 * PiNet — Permanent Agent Network
 *
 * Agent-to-agent DMs + team chats via files.
 *
 * Usage:
 *   /pinet <name>              — log in (DMs only)
 *   /pinet <name>@<team>       — log in + join/create team
 *   /pinet <name>@<t1>,<t2>    — log in + join multiple teams
 *   /pinet                     — show status
 *   /pinet off                 — go offline
 *
 * Tools (personal, after any login):
 *   pinet_send   — DM another agent
 *   pinet_mail   — check personal DMs
 *   pinet_list   — list online agents
 *
 * Tools (team, after login with @team):
 *   pinet_team_send — send message to a team
 *   pinet_team_read — read unread team messages
 *   pinet_team_list — list your teams and members
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

interface Identity {
  name: string;
  created: string;
}

interface PersonalMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

interface TeamMessage {
  id: string;
  from: string;
  team: string;
  body: string;
  timestamp: string;
}

interface PresenceEntry {
  name: string;
  status: "online" | "offline";
  pid: number;
  lastSeen: string;
}

interface TeamMeta {
  name: string;
  members: string[];
  created: string;
}

// =============================================================================
// State
// =============================================================================

const PINET_DIR = path.join(process.env.HOME || "~", ".pinet");

let myIdentity: Identity | null = null;
let myTeams: string[] = [];

// Personal mailbox watcher
let personalWatcher: fs.FSWatcher | null = null;
let personalLineCount = 0;
let personalDebounce: ReturnType<typeof setTimeout> | null = null;

// Team watchers: Map<teamName, { watcher, lineCount, debounce }>
let teamWatchers: Map<string, {
  watcher: fs.FSWatcher;
  lineCount: number;
  debounce: ReturnType<typeof setTimeout> | null;
}> = new Map();

// =============================================================================
// Helpers
// =============================================================================

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function pinetPath(...segments: string[]): string {
  return path.join(PINET_DIR, ...segments);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((m) => m !== null);
}

function appendJsonl(filePath: string, obj: unknown) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}

function writePresence(name: string, status: "online" | "offline") {
  ensureDir(pinetPath("presence"));
  const entry: PresenceEntry = {
    name,
    status,
    pid: process.pid,
    lastSeen: new Date().toISOString(),
  };
  fs.writeFileSync(pinetPath("presence", `${name}.json`), JSON.stringify(entry, null, 2));
}

function readAllPresence(): PresenceEntry[] {
  const dir = pinetPath("presence");
  if (!fs.existsSync(dir)) return [];
  const entries: PresenceEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry: PresenceEntry = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf-8")
      );
      if (entry.status === "online" && !isProcessAlive(entry.pid)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch {}
        continue;
      }
      entries.push(entry);
    } catch {}
  }
  return entries;
}

function readOwnMailbox(): PersonalMessage[] {
  if (!myIdentity) return [];
  return readJsonl(pinetPath("mailboxes", `${myIdentity.name}.mailbox.jsonl`));
}

// =============================================================================
// Team Helpers
// =============================================================================

function readTeamMeta(teamName: string): TeamMeta | null {
  const filePath = pinetPath("teams", teamName, "meta.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeTeamMeta(meta: TeamMeta) {
  ensureDir(pinetPath("teams", meta.name));
  fs.writeFileSync(
    pinetPath("teams", meta.name, "meta.json"),
    JSON.stringify(meta, null, 2)
  );
}

function joinTeam(teamName: string, agentName: string): boolean {
  let meta = readTeamMeta(teamName);
  if (!meta) {
    // Create new team
    meta = {
      name: teamName,
      members: [agentName],
      created: new Date().toISOString(),
    };
    writeTeamMeta(meta);
    return true;
  }

  // Already a member?
  if (meta.members.includes(agentName)) return true;

  // Add to members
  meta.members.push(agentName);
  writeTeamMeta(meta);
  return true;
}

function readTeamMessages(teamName: string): TeamMessage[] {
  return readJsonl(pinetPath("teams", teamName, "messages.jsonl"));
}

// =============================================================================
// Personal Mailbox Delivery
// =============================================================================

function deliverPersonalMessages(pi: ExtensionAPI, messages: PersonalMessage[]) {
  if (messages.length === 0) return;

  const summary = messages
    .map((m) => `${m.from}: ${m.body}`)
    .join("\n");

  pi.sendMessage(
    {
      customType: "pinet",
      content: `[PiNet DM] ${messages.length} new message${messages.length > 1 ? "s" : ""}:\n${summary}`,
      display: true,
    },
    { triggerTurn: true }
  );
}

// =============================================================================
// Team Message Delivery
// =============================================================================

function deliverTeamMessages(pi: ExtensionAPI, teamName: string, messages: TeamMessage[]) {
  if (messages.length === 0) return;

  // Filter out own messages
  const filtered = messages.filter((m) => m.from !== myIdentity!.name);
  if (filtered.length === 0) return;

  const summary = filtered
    .map((m) => `${m.from}: ${m.body}`)
    .join("\n");

  pi.sendMessage(
    {
      customType: "pinet-team",
      content: `[PiNet #${teamName}] ${filtered.length} new message${filtered.length > 1 ? "s" : ""}:\n${summary}`,
      display: true,
    },
    { triggerTurn: true }
  );
}

// =============================================================================
// Personal Mailbox Watcher
// =============================================================================

function startPersonalWatcher(pi: ExtensionAPI) {
  if (!myIdentity) return;

  const mailboxPath = pinetPath("mailboxes", `${myIdentity.name}.mailbox.jsonl`);
  ensureDir(path.dirname(mailboxPath));

  if (fs.existsSync(mailboxPath)) {
    const content = fs.readFileSync(mailboxPath, "utf-8").trim();
    personalLineCount = content ? content.split("\n").length : 0;
  } else {
    personalLineCount = 0;
  }

  try {
    personalWatcher = fs.watch(path.dirname(mailboxPath), (_eventType, filename) => {
      if (!filename || filename !== `${myIdentity!.name}.mailbox.jsonl`) return;
      if (personalDebounce) clearTimeout(personalDebounce);
      personalDebounce = setTimeout(() => {
        personalDebounce = null;
        processNewPersonalMessages(pi);
      }, 100);
    });
  } catch {}
}

function processNewPersonalMessages(pi: ExtensionAPI) {
  if (!myIdentity) return;
  const all = readOwnMailbox();
  const newMsgs = all.slice(personalLineCount);
  personalLineCount = all.length;
  if (newMsgs.length > 0) {
    deliverPersonalMessages(pi, newMsgs);
  }
}

function stopPersonalWatcher() {
  if (personalDebounce) { clearTimeout(personalDebounce); personalDebounce = null; }
  if (personalWatcher) { personalWatcher.close(); personalWatcher = null; }
}

// =============================================================================
// Team Watcher
// =============================================================================

function startTeamWatcher(pi: ExtensionAPI, teamName: string) {
  const msgPath = pinetPath("teams", teamName, "messages.jsonl");
  ensureDir(path.dirname(msgPath));

  let lineCount = 0;
  if (fs.existsSync(msgPath)) {
    const content = fs.readFileSync(msgPath, "utf-8").trim();
    lineCount = content ? content.split("\n").length : 0;
  }

  try {
    const watcher = fs.watch(path.dirname(msgPath), (_eventType, filename) => {
      if (!filename || filename !== "messages.jsonl") return;

      const state = teamWatchers.get(teamName);
      if (!state) return;
      if (state.debounce) clearTimeout(state.debounce);
      state.debounce = setTimeout(() => {
        if (!state) return;
        state.debounce = null;
        processNewTeamMessages(pi, teamName);
      }, 100);
    });

    teamWatchers.set(teamName, { watcher, lineCount, debounce: null });
  } catch {}
}

function processNewTeamMessages(pi: ExtensionAPI, teamName: string) {
  const state = teamWatchers.get(teamName);
  if (!state) return;

  const all = readTeamMessages(teamName);
  const newMsgs = all.slice(state.lineCount);
  state.lineCount = all.length;

  if (newMsgs.length > 0) {
    deliverTeamMessages(pi, teamName, newMsgs);
  }
}

function stopAllTeamWatchers() {
  for (const [, state] of teamWatchers) {
    if (state.debounce) clearTimeout(state.debounce);
    state.watcher.close();
  }
  teamWatchers.clear();
}

// =============================================================================
// Tool Registration
// =============================================================================

function registerPersonalTools(pi: ExtensionAPI) {
  // pinet_send
  pi.registerTool({
    name: "pinet_send",
    label: "Send PiNet DM",
    description:
      "Send a direct message to another agent. Delivered immediately if online, queued if offline.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name" }),
      message: Type.String({ description: "Message text" }),
    }),
    async execute(_toolCallId, params) {
      if (!myIdentity) {
        return { content: [{ type: "text", text: "Not logged in. Use /pinet <name> first." }] };
      }

      const { to, message } = params as { to: string; message: string };
      const allPresence = readAllPresence();
      const recipientOnline = allPresence.some((p) => p.name === to);

      const msg: PersonalMessage = {
        id: randomUUID(),
        from: myIdentity.name,
        to,
        body: message,
        timestamp: new Date().toISOString(),
      };

      appendJsonl(pinetPath("mailboxes", `${to}.mailbox.jsonl`), msg);

      return {
        content: [{
          type: "text",
          text: `Message sent to ${to}. ${recipientOnline ? "They are online." : "They are offline — message queued."}`,
        }],
      };
    },
  });

  // pinet_mail
  pi.registerTool({
    name: "pinet_mail",
    label: "Check PiNet Mail",
    description: "Check your personal PiNet mailbox for DMs.",
    parameters: Type.Object({
      unreadOnly: Type.Optional(
        Type.Boolean({ description: "Only show unread messages (default: true)" })
      ),
    }),
    async execute(_toolCallId, params) {
      if (!myIdentity) {
        return { content: [{ type: "text", text: "Not logged in." }] };
      }

      const { unreadOnly = true } = params as { unreadOnly?: boolean };
      const allMessages = readOwnMailbox();
      const messages = unreadOnly ? allMessages.slice(personalLineCount) : allMessages;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: unreadOnly ? "No unread messages." : "No messages." }] };
      }

      const formatted = messages
        .map((m) => `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.from}: ${m.body}`)
        .join("\n");

      return { content: [{ type: "text", text: formatted }] };
    },
  });

  // pinet_list
  pi.registerTool({
    name: "pinet_list",
    label: "List PiNet Agents",
    description: "List all agents and their online status.",
    parameters: Type.Object({}),
    async execute() {
      const allPresence = readAllPresence();
      if (allPresence.length === 0) {
        return { content: [{ type: "text", text: "No agents on the network." }] };
      }

      const lines = allPresence.map((p) => {
        const indicator = p.status === "online" ? "🟢" : "⚪";
        return `${indicator} ${p.name} (${p.status})`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}

function registerTeamTools(pi: ExtensionAPI) {
  // pinet_team_send
  pi.registerTool({
    name: "pinet_team_send",
    label: "Send Team Message",
    description: "Send a message to a team chat. All members see it.",
    parameters: Type.Object({
      team: Type.String({ description: "Team name" }),
      message: Type.String({ description: "Message text" }),
    }),
    async execute(_toolCallId, params) {
      if (!myIdentity) {
        return { content: [{ type: "text", text: "Not logged in." }] };
      }

      const { team, message } = params as { team: string; message: string };

      if (!myTeams.includes(team)) {
        return { content: [{ type: "text", text: `You are not in team "${team}". Your teams: ${myTeams.join(", ") || "none"}` }] };
      }

      const msg: TeamMessage = {
        id: randomUUID(),
        from: myIdentity.name,
        team,
        body: message,
        timestamp: new Date().toISOString(),
      };

      appendJsonl(pinetPath("teams", team, "messages.jsonl"), msg);

      return { content: [{ type: "text", text: `Message sent to #${team}.` }] };
    },
  });

  // pinet_team_read
  pi.registerTool({
    name: "pinet_team_read",
    label: "Read Team Messages",
    description: "Read unread messages from a team chat.",
    parameters: Type.Object({
      team: Type.String({ description: "Team name" }),
      unreadOnly: Type.Optional(
        Type.Boolean({ description: "Only show unread (default: true)" })
      ),
    }),
    async execute(_toolCallId, params) {
      if (!myIdentity) {
        return { content: [{ type: "text", text: "Not logged in." }] };
      }

      const { team, unreadOnly = true } = params as { team: string; unreadOnly?: boolean };

      if (!myTeams.includes(team)) {
        return { content: [{ type: "text", text: `You are not in team "${team}".` }] };
      }

      const allMessages = readTeamMessages(team);
      const state = teamWatchers.get(team);
      const readPointer = state?.lineCount ?? allMessages.length;

      const messages = unreadOnly ? allMessages.slice(readPointer) : allMessages;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: unreadOnly ? `No unread messages in #${team}.` : `No messages in #${team}.` }] };
      }

      const formatted = messages
        .map((m) => `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.from}: ${m.body}`)
        .join("\n");

      return { content: [{ type: "text", text: formatted }] };
    },
  });

  // pinet_team_list
  pi.registerTool({
    name: "pinet_team_list",
    label: "List Teams",
    description: "List all teams you are a member of and their members.",
    parameters: Type.Object({}),
    async execute() {
      if (!myIdentity) {
        return { content: [{ type: "text", text: "Not logged in." }] };
      }

      if (myTeams.length === 0) {
        return { content: [{ type: "text", text: "You are not in any teams. Log in with /pinet name@team to join one." }] };
      }

      const lines = myTeams.map((teamName) => {
        const meta = readTeamMeta(teamName);
        const members = meta?.members.join(", ") ?? "unknown";
        return `#${teamName}: ${members}`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}

// =============================================================================
// Login / Logout
// =============================================================================

function doLogin(pi: ExtensionAPI, name: string, teams: string[], ctx: { hasUI: boolean; ui: any }) {
  // Validate name
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    if (ctx.hasUI) ctx.ui.notify("Invalid name. Use letters, numbers, underscore, hyphen.", "error");
    return;
  }

  // Validate team names
  for (const t of teams) {
    if (!/^[a-zA-Z0-9_-]+$/.test(t)) {
      if (ctx.hasUI) ctx.ui.notify(`Invalid team name "${t}". Use letters, numbers, underscore, hyphen.`, "error");
      return;
    }
  }

  // Check if name is already online (different PID)
  const existingPath = pinetPath("presence", `${name}.json`);
  if (fs.existsSync(existingPath)) {
    try {
      const existing: PresenceEntry = JSON.parse(fs.readFileSync(existingPath, "utf-8"));
      if (existing.status === "online" && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        if (ctx.hasUI) ctx.ui.notify(`"${name}" is already online (PID ${existing.pid})`, "error");
        return;
      }
    } catch {}
  }

  // Register identity
  myIdentity = { name, created: new Date().toISOString() };
  myTeams = teams;
  ensureDir(pinetPath());
  appendJsonl(pinetPath("identities.jsonl"), myIdentity);

  // Set presence online
  writePresence(name, "online");

  // Start personal mailbox watcher
  startPersonalWatcher(pi);

  // Register personal tools
  registerPersonalTools(pi);

  // Join teams + start team watchers
  const teamNotes: string[] = [];
  for (const team of teams) {
    joinTeam(team, name);
    startTeamWatcher(pi, team);
    teamNotes.push(`#${team}`);
  }

  // Register team tools (if any teams)
  if (teams.length > 0) {
    registerTeamTools(pi);
  }

  // Build status message
  const backlog = readOwnMailbox().slice(personalLineCount);
  const parts = [`Logged in as ${name} ✨`];
  if (teamNotes.length > 0) {
    parts.push(`Teams: ${teamNotes.join(", ")}`);
  }
  if (backlog.length > 0) {
    parts.push(`${backlog.length} unread DMs`);
  }

  if (ctx.hasUI) {
    ctx.ui.notify(parts.join("\n  "), "success");
  }
}

function doLogout(ctx: { hasUI: boolean; ui: any }) {
  if (!myIdentity) {
    if (ctx.hasUI) ctx.ui.notify("Not logged in.", "warning");
    return;
  }

  const name = myIdentity.name;
  writePresence(name, "offline");
  stopPersonalWatcher();
  stopAllTeamWatchers();
  myIdentity = null;
  myTeams = [];
  personalLineCount = 0;

  if (ctx.hasUI) {
    ctx.ui.notify(`${name} went offline.`, "info");
  }
}

// =============================================================================
// Parse login arg: "Name@team1,team2" → { name, teams }
// =============================================================================

function parseLoginArg(arg: string): { name: string; teams: string[] } {
  const atIdx = arg.indexOf("@");
  if (atIdx === -1) {
    return { name: arg, teams: [] };
  }
  const name = arg.slice(0, atIdx);
  const teams = arg.slice(atIdx + 1).split(",").map((t) => t.trim()).filter(Boolean);
  return { name, teams };
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pinet", {
    description: "Log into PiNet: /pinet <name>[@<team1,team2>] | /pinet off | /pinet (status)",

    handler: async (args, ctx) => {
      const arg = args.trim();

      // Logout
      if (arg === "off") {
        doLogout(ctx);
        return;
      }

      // Status
      if (!arg && myIdentity) {
        const presence = readAllPresence();
        const onlinePeers = presence.filter((p) => p.status === "online" && p.name !== myIdentity!.name);
        const mailbox = readOwnMailbox();
        const unread = mailbox.length - personalLineCount;

        const parts = [`Logged in as ${myIdentity.name}`];
        if (myTeams.length > 0) {
          parts.push(`Teams: ${myTeams.map((t) => `#${t}`).join(", ")}`);
        }
        parts.push(`${onlinePeers.length} peer${onlinePeers.length !== 1 ? "s" : ""} online`);
        if (unread > 0) {
          parts.push(`${unread} unread DM${unread !== 1 ? "s" : ""}`);
        }

        ctx.ui.notify(parts.join("\n  "), "info");
        return;
      }

      // Need a name
      if (!arg) {
        ctx.ui.notify("Usage: /pinet <name>[@<team>]", "warning");
        return;
      }

      // Already logged in?
      if (myIdentity) {
        ctx.ui.notify(`Already logged in as ${myIdentity.name}. Use /pinet off first.`, "warning");
        return;
      }

      const { name, teams } = parseLoginArg(arg);
      doLogin(pi, name, teams, ctx);
    },
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    if (myIdentity) {
      writePresence(myIdentity.name, "offline");
      stopPersonalWatcher();
      stopAllTeamWatchers();
    }
  });
}
