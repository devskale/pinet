/**
 * PiNet — Tool definitions for the LLM.
 *
 * Personal tools: pinet_send, pinet_mail, pinet_list
 * Team tools:     pinet_team_send, pinet_team_read, pinet_team_list
 *
 * Tools are registered after login. Team tools only appear when
 * the agent is logged in with @team.
 */

import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  pinetPath, readAllPresence, readJsonl, appendJsonl,
  readTeamMeta, readTeamMessages,
} from "./store";
import { getPersonalLineCount, getTeamLineCount } from "./watchers";
import { PersonalMessage, TeamMessage } from "./types";

// =============================================================================
// State
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
// Helpers
// =============================================================================

function notLoggedIn() {
  return { content: [{ type: "text", text: "Not logged in. Use /pinet <name> first." }] };
}

function textReply(text: string) {
  return { content: [{ type: "text", text }] };
}

// =============================================================================
// Personal tools
// =============================================================================

export function registerPersonalTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pinet_send",
    label: "Send PiNet DM",
    description:
      "Send a direct message to another agent. Delivered immediately if online, queued if offline.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name" }),
      message: Type.String({ description: "Message text" }),
    }),
    async execute(_id, params) {
      if (!myName) return notLoggedIn();
      const { to, message } = params as { to: string; message: string };

      const online = readAllPresence().some((p) => p.name === to);

      appendJsonl(pinetPath("mailboxes", `${to}.mailbox.jsonl`), {
        id: randomUUID(),
        from: myName,
        to,
        body: message,
        timestamp: new Date().toISOString(),
      } satisfies PersonalMessage);

      return textReply(
        `Message sent to ${to}. ${online ? "They are online." : "They are offline — message queued."}`
      );
    },
  });

  pi.registerTool({
    name: "pinet_mail",
    label: "Check PiNet Mail",
    description: "Check your personal PiNet mailbox for DMs.",
    parameters: Type.Object({
      unreadOnly: Type.Optional(
        Type.Boolean({ description: "Only show unread messages (default: true)" })
      ),
    }),
    async execute(_id, params) {
      if (!myName) return notLoggedIn();
      const { unreadOnly = true } = params as { unreadOnly?: boolean };

      const all = readJsonl<PersonalMessage>(pinetPath("mailboxes", `${myName}.mailbox.jsonl`));
      const messages = unreadOnly ? all.slice(getPersonalLineCount()) : all;

      if (messages.length === 0) {
        return textReply(unreadOnly ? "No unread messages." : "No messages.");
      }

      return textReply(
        messages
          .map((m) => `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.from}: ${m.body}`)
          .join("\n")
      );
    },
  });

  pi.registerTool({
    name: "pinet_list",
    label: "List PiNet Agents",
    description: "List all agents and their online status.",
    parameters: Type.Object({}),
    async execute() {
      const all = readAllPresence();
      if (all.length === 0) return textReply("No agents on the network.");

      return textReply(
        all
          .map((p) => `${p.status === "online" ? "🟢" : "⚪"} ${p.name} (${p.status})`)
          .join("\n")
      );
    },
  });
}

// =============================================================================
// Team tools
// =============================================================================

export function registerTeamTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pinet_team_send",
    label: "Send Team Message",
    description: "Send a message to a team chat. All members see it.",
    parameters: Type.Object({
      team: Type.String({ description: "Team name" }),
      message: Type.String({ description: "Message text" }),
    }),
    async execute(_id, params) {
      if (!myName) return notLoggedIn();
      const { team, message } = params as { team: string; message: string };

      if (!myTeams.includes(team)) {
        return textReply(`You are not in team "${team}". Your teams: ${myTeams.join(", ") || "none"}`);
      }

      appendJsonl(pinetPath("teams", team, "messages.jsonl"), {
        id: randomUUID(),
        from: myName,
        team,
        body: message,
        timestamp: new Date().toISOString(),
      } satisfies TeamMessage);

      return textReply(`Message sent to #${team}.`);
    },
  });

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
    async execute(_id, params) {
      if (!myName) return notLoggedIn();
      const { team, unreadOnly = true } = params as { team: string; unreadOnly?: boolean };

      if (!myTeams.includes(team)) {
        return textReply(`You are not in team "${team}".`);
      }

      const all = readTeamMessages(team);
      const messages = unreadOnly ? all.slice(getTeamLineCount(team)) : all;

      if (messages.length === 0) {
        return textReply(unreadOnly ? `No unread messages in #${team}.` : `No messages in #${team}.`);
      }

      return textReply(
        messages
          .map((m) => `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.from}: ${m.body}`)
          .join("\n")
      );
    },
  });

  pi.registerTool({
    name: "pinet_team_list",
    label: "List Teams",
    description: "List all teams you are a member of and their members.",
    parameters: Type.Object({}),
    async execute() {
      if (!myName) return notLoggedIn();
      if (myTeams.length === 0) {
        return textReply("You are not in any teams. Log in with /pinet name@team to join one.");
      }

      return textReply(
        myTeams
          .map((name) => {
            const meta = readTeamMeta(name);
            const members = meta?.members.join(", ") ?? "unknown";
            const unread = readTeamMessages(name)
              .slice(getTeamLineCount(name))
              .filter((m: TeamMessage) => m.from !== myName).length;
            const badge = unread > 0 ? ` (${unread} unread)` : "";
            return `#${name}: ${members}${badge}`;
          })
          .join("\n")
      );
    },
  });
}
