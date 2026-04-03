/**
 * PiNet — Tool registration (personal + team)
 */

import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { pinetPath, readAllPresence, readJsonl, appendJsonl, readTeamMeta, readTeamMessages } from "./store";
import { getPersonalLineCount, getTeamLineCount } from "./watchers";
import { PersonalMessage, TeamMessage } from "./types";

// =============================================================================
// State (set on login)
// =============================================================================

let myName: string | null = null;
let myTeams: string[] = [];

export function setToolIdentity(name: string, teams: string[]) {
  myName = name;
  myTeams = teams;
}

export function resetToolIdentity() {
  myName = null;
  myTeams = [];
}

// =============================================================================
// Personal tools
// =============================================================================

export function registerPersonalTools(pi: ExtensionAPI) {
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
      if (!myName) {
        return { content: [{ type: "text", text: "Not logged in. Use /pinet <name> first." }] };
      }

      const { to, message } = params as { to: string; message: string };
      const allPresence = readAllPresence();
      const recipientOnline = allPresence.some((p) => p.name === to);

      const msg: PersonalMessage = {
        id: randomUUID(),
        from: myName,
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
      if (!myName) {
        return { content: [{ type: "text", text: "Not logged in." }] };
      }

      const { unreadOnly = true } = params as { unreadOnly?: boolean };
      const allMessages = readJsonl(pinetPath("mailboxes", `${myName}.mailbox.jsonl`)) as PersonalMessage[];
      const messages = unreadOnly ? allMessages.slice(getPersonalLineCount()) : allMessages;

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

// =============================================================================
// Team tools
// =============================================================================

export function registerTeamTools(pi: ExtensionAPI) {
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
      if (!myName) {
        return { content: [{ type: "text", text: "Not logged in." }] };
      }

      const { team, message } = params as { team: string; message: string };

      if (!myTeams.includes(team)) {
        return { content: [{ type: "text", text: `You are not in team "${team}". Your teams: ${myTeams.join(", ") || "none"}` }] };
      }

      const msg: TeamMessage = {
        id: randomUUID(),
        from: myName,
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
      if (!myName) {
        return { content: [{ type: "text", text: "Not logged in." }] };
      }

      const { team, unreadOnly = true } = params as { team: string; unreadOnly?: boolean };

      if (!myTeams.includes(team)) {
        return { content: [{ type: "text", text: `You are not in team "${team}".` }] };
      }

      const allMessages = readTeamMessages(team);
      const readPointer = getTeamLineCount(team);
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
      if (!myName) {
        return { content: [{ type: "text", text: "Not logged in." }] };
      }

      if (myTeams.length === 0) {
        return { content: [{ type: "text", text: "You are not in any teams. Log in with /pinet name@team to join one." }] };
      }

      const lines = myTeams.map((teamName) => {
        const meta = readTeamMeta(teamName);
        const members = meta?.members.join(", ") ?? "unknown";
        const unread = readTeamMessages(teamName)
          .slice(getTeamLineCount(teamName))
          .filter((m: TeamMessage) => m.from !== myName).length;
        const badge = unread > 0 ? ` (${unread} unread)` : "";
        return `#${teamName}: ${members}${badge}`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
