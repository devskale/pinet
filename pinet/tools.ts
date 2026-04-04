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

// Rate limiting
const TEAM_SEND_LIMIT = 10;
const TEAM_SEND_WINDOW_MS = 60_000;
const TEAM_SEND_MIN_GAP_MS = 5_000;
const teamSendLog = new Map<string, number[]>();
const teamLastSend = new Map<string, number>();

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
    description: "Send a direct message to another agent. Be brief.",
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

      return textReply(`send to ${myName}->${to}: ${message}`);
    },
  });

  pi.registerTool({
    name: "pinet_mail",
    label: "Check PiNet Mail",
    description: "Check your personal PiNet mailbox for DMs.",
    parameters: Type.Object({
      unreadOnly: Type.Optional(
        Type.Boolean({ description: "Only show unread (default: true)" })
      ),
    }),
    async execute(_id, params) {
      if (!myName) return notLoggedIn();
      const { unreadOnly = true } = params as { unreadOnly?: boolean };

      const all = readJsonl<PersonalMessage>(pinetPath("mailboxes", `${myName}.mailbox.jsonl`));
      const messages = unreadOnly ? all.slice(getPersonalLineCount()) : all;

      if (messages.length === 0) return textReply("No unread DMs.");

      return textReply(
        messages
          .map((m) => `receive from ${m.from}->${myName}: ${m.body}`)
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
      if (all.length === 0) return textReply("No agents.");

      return textReply(
        all
          .map((p) => `${p.status === "online" ? "\u25CF" : "\u25CB"} ${p.name}`)
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
    label: "pinet_team_send",
    description: "Send a message to a team chat. Be brief and factual — no greetings, no emojis, no filler.",
    parameters: Type.Object({
      team: Type.String({ description: "Team name" }),
      message: Type.String({ description: "Message text" }),
    }),
    async execute(_id, params) {
      if (!myName) return notLoggedIn();
      const { team, message } = params as { team: string; message: string };

      if (!myTeams.includes(team)) {
        return textReply(`Not in #${team}. Your teams: ${myTeams.map(t => "#" + t).join(", ") || "none"}`);
      }

      const now = Date.now();
      const lastSend = teamLastSend.get(team) || 0;
      if (now - lastSend < TEAM_SEND_MIN_GAP_MS) {
        const waitSec = Math.ceil((TEAM_SEND_MIN_GAP_MS - (now - lastSend)) / 1000);
        return textReply(`Wait ${waitSec}s.`);
      }

      const times = (teamSendLog.get(team) || []).filter(t => now - t < TEAM_SEND_WINDOW_MS);
      if (times.length >= TEAM_SEND_LIMIT) {
        const oldest = times[0];
        const waitSec = Math.ceil((TEAM_SEND_WINDOW_MS - (now - oldest)) / 1000);
        return textReply(`Rate limited. Wait ${waitSec}s.`);
      }
      times.push(now);
      teamSendLog.set(team, times);
      teamLastSend.set(team, now);

      appendJsonl(pinetPath("teams", team, "messages.jsonl"), {
        id: randomUUID(),
        from: myName,
        team,
        body: message,
        timestamp: new Date().toISOString(),
      } satisfies TeamMessage);

      return textReply(`send to ${myName}@${team}: ${message}`);
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

      if (!myTeams.includes(team)) return textReply(`Not in #${team}.`);

      const all = readTeamMessages(team);
      const messages = unreadOnly ? all.slice(getTeamLineCount(team)) : all;
      if (messages.length === 0) return textReply(`No unread in #${team}.`);

      return textReply(
        messages
          .map((m) => `receive from ${m.from}@${team}: ${m.body}`)
          .join("\n")
      );
    },
  });

  pi.registerTool({
    name: "pinet_team_list",
    label: "List Teams",
    description: "List your teams, members, and unread counts.",
    parameters: Type.Object({}),
    async execute() {
      if (!myName) return notLoggedIn();
      if (myTeams.length === 0) return textReply("No teams. Use /pinet name@team.");

      return textReply(
        myTeams
          .map((name) => {
            const meta = readTeamMeta(name);
            const members = meta?.members.join(", ") ?? "?";
            const unread = readTeamMessages(name)
              .slice(getTeamLineCount(name))
              .filter((m: TeamMessage) => m.from !== myName).length;
            return `#${name} [${members}]${unread > 0 ? ` ${unread} unread` : ""}`;
          })
          .join("\n")
      );
    },
  });
}
